#!/usr/bin/env bash
# archive-recordings.sh —— 录音冷热分层归档
#
# 策略:
#   1. pcap 超 ARCHIVE_DAYS 天(默认 30)→ 转 FLAC 存 recordings/flac/,校验后删原 pcap
#   2. recordings/cache/ 播放缓存超 CACHE_DAYS 天(默认 7)→ 直接删(可再生)
#   3. FLAC 归档保留(无损,可随时转回 WAV;播放端 audio.js 会自动 fallback 到归档)
#
# 用法:
#   ./archive-recordings.sh             # 正常执行
#   ./archive-recordings.sh --dry-run   # 只打印将做什么,不动文件
#   ARCHIVE_DAYS=60 ./archive-recordings.sh
#
# 权限:pcap 是 rtpengine 容器写的(root 所有);普通用户跑时无权限文件会跳过并警告,
#       建议 sudo 运行(cron/systemd 里配 root 或先 chown)。
set -uo pipefail
cd "$(dirname "$0")/.."

ARCHIVE_DAYS="${ARCHIVE_DAYS:-30}"
CACHE_DAYS="${CACHE_DAYS:-7}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

PCAP_DIR="recordings/pcaps"
FLAC_DIR="recordings/flac"
CACHE_DIR="recordings/cache"
TMP_DIR="recordings/tmp"   # 中间产物放这里(siprec-web 容器挂载可见,ffmpeg 在容器里跑)
CONVERTER="tools/pcap2audio.js"
LOG() { echo "[archive $(date '+%F %T')] $*"; }

mkdir -p "$FLAC_DIR" "$TMP_DIR"

# ---------- 数据库回填(archived / audio_size_bytes) ----------
db_query() {
  docker exec -i oreka-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" siprec' <<< "$1" 2>/dev/null
}

# 由 pcap 文件名还原 SIP Call-ID:<callid with %40>-<random>.pcap
pcap_to_callid() {
  local base="$1"
  base="${base%-*}"                 # 去掉 -<random>
  printf '%s' "${base//%40/@}"      # %40 -> @
}

update_db_archived() {
  local callid="$1" size="$2"
  local safe="${callid//\'/\'\'}"   # 单引号转义
  local tables
  tables=$(db_query "SHOW TABLES LIKE 'recording\\_metadata\\_______';" | tail -n +2)
  for t in $tables; do
    db_query "UPDATE \`$t\` SET archived=1, audio_size_bytes=$size WHERE original_call_id='$safe';"
  done
}

# ---------- ffmpeg 执行器:统一走 siprec-web 容器(里面有 ffmpeg 且能看到 /recordings) ----------
# 用法: ffmpeg_to_flac <宿主wav相对recordings的路径> <宿主flac相对recordings的路径>
ffmpeg_to_flac() {
  local wav_rel="$1" flac_rel="$2"
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx siprec-web; then
    docker exec siprec-web ffmpeg -y -i "/recordings/${wav_rel}" -codec:a flac "/recordings/${flac_rel}" >/dev/null 2>&1
  elif command -v ffmpeg >/dev/null 2>&1; then
    ffmpeg -y -i "recordings/${wav_rel}" -codec:a flac "recordings/${flac_rel}" >/dev/null 2>&1
  else
    docker run --rm -v "$PWD/recordings:/recordings" -w /recordings jrottenberg/ffmpeg:4.4-alpine \
      -y -i "${wav_rel}" -codec:a flac "${flac_rel}" >/dev/null 2>&1
  fi
}

# ---------- 1. pcap → FLAC 归档 ----------
archived=0; skipped=0; freed=0; failed=0
LOG "扫描 $PCAP_DIR 中超过 ${ARCHIVE_DAYS} 天的 pcap ..."

while IFS= read -r -d '' pcap; do
  base="$(basename "$pcap" .pcap)"
  flac="$FLAC_DIR/${base}.flac"
  size=$(stat -c%s "$pcap" 2>/dev/null || echo 0)

  if [ "$DRY_RUN" = "1" ]; then
    LOG "[dry-run] 将归档: $pcap ($((size/1024)) KB) -> $flac 并删原文件"
    archived=$((archived+1)); freed=$((freed+size))
    continue
  fi

  # 已归档过(flac 存在且非空)直接删 pcap
  if [ -s "$flac" ]; then
    if rm -f "$pcap" 2>/dev/null; then
      LOG "已存在归档,删原 pcap: $base"
      archived=$((archived+1)); freed=$((freed+size))
    else
      LOG "⚠️ 无权限删除: $pcap(需要 sudo)"
      skipped=$((skipped+1))
    fi
    continue
  fi

  # pcap → WAV(纯 Node,宿主机可跑;产物挪到 recordings/tmp/ 供容器 ffmpeg 使用)
  tmpwav_rel="tmp/arch_${base}.wav"
  tmpwav="recordings/${tmpwav_rel}"
  if ! node "$CONVERTER" "$pcap" >/dev/null 2>&1; then
    LOG "⚠️ pcap 解码失败(可能无音频): $pcap,跳过"
    failed=$((failed+1)); continue
  fi
  produced="${pcap%.pcap}.wav"
  if [ ! -s "$produced" ]; then
    LOG "⚠️ 转换未产出 WAV: $pcap,跳过"
    failed=$((failed+1)); continue
  fi
  mv -f "$produced" "$tmpwav" 2>/dev/null || { cp "$produced" "$tmpwav" && rm -f "$produced"; }

  # WAV → FLAC(容器内 ffmpeg,路径都是 /recordings 相对)
  tmpflac_rel="tmp/arch_${base}.flac"
  tmpflac="recordings/${tmpflac_rel}"
  if ! ffmpeg_to_flac "$tmpwav_rel" "$tmpflac_rel"; then
    LOG "⚠️ ffmpeg 转 FLAC 失败: $base"; rm -f "$tmpwav"; failed=$((failed+1)); continue
  fi
  rm -f "$tmpwav"

  # 校验 FLAC 非空再删 pcap(安全:宁可留 pcap 不删)
  if [ ! -s "$tmpflac" ]; then
    LOG "⚠️ FLAC 为空,保留原 pcap: $base"; failed=$((failed+1)); continue
  fi
  mv -f "$tmpflac" "$flac" 2>/dev/null || { cp "$tmpflac" "$flac" && rm -f "$tmpflac"; }

  if rm -f "$pcap" 2>/dev/null; then
    flac_size=$(stat -c%s "$flac")
    callid=$(pcap_to_callid "$(basename "$pcap" .pcap)")
    update_db_archived "$callid" "$flac_size" || LOG "⚠️ 数据库回填失败: $callid"
    LOG "归档完成: $base  ($((size/1024)) KB pcap -> $((flac_size/1024)) KB flac)"
    archived=$((archived+1)); freed=$((freed+size))
  else
    LOG "⚠️ 已转 FLAC 但无权限删原 pcap(需要 sudo): $pcap"
    skipped=$((skipped+1))
  fi
done < <(find "$PCAP_DIR" -maxdepth 1 -name '*.pcap' -type f -mtime "+$ARCHIVE_DAYS" -print0 2>/dev/null)

# ---------- 2. 播放缓存清理 ----------
cache_cleaned=0
while IFS= read -r -d '' f; do
  if [ "$DRY_RUN" = "1" ]; then
    LOG "[dry-run] 将删缓存: $f"
    cache_cleaned=$((cache_cleaned+1))
  elif rm -f "$f" 2>/dev/null; then
    cache_cleaned=$((cache_cleaned+1))
  fi
done < <(find "$CACHE_DIR" -type f -mtime "+$CACHE_DAYS" -print0 2>/dev/null)

LOG "完成:归档 $archived 个(释放 $((freed/1024/1024)) MB),跳过 $skipped,失败 $failed,清缓存 $cache_cleaned 个"
[ "$skipped" -gt 0 ] && LOG "提示:有 $skipped 个文件无权限删除,建议 sudo 运行或先 chown -R \$USER recordings/"
exit 0

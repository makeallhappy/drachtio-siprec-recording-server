#!/usr/bin/env bash
# sipp-test.sh —— 一键 SIPREC 测试呼叫 + 日志收集 + 落库验证
# 用法: ./sipp-test.sh [呼叫数,默认 1]
#
# 产出:
#   sipp-logs/sipp_messages.log   完整 SIP 信令
#   sipp-logs/sipp_errors.log     错误(呼叫成功则为空)
#   sipp-logs/sipp_screen.log     呼叫统计屏幕存档
#   并打印最新一条 MySQL 元数据 + 录音文件
set -euo pipefail
cd "$(dirname "$0")"

CALLS="${1:-1}"
LOGDIR="$PWD/sipp-logs"
mkdir -p "$LOGDIR"
# 每次测试前清掉旧日志,避免混
rm -f "$LOGDIR"/sipp_*.log

echo "=== 发 $CALLS 通 SIPREC 测试呼叫(带完整日志)==="
docker run --rm --network host \
  -v "$PWD/test/scenarios:/tmp" \
  -v "$LOGDIR:/logs" \
  drachtio/sipp:latest sipp 127.0.0.1:${SIP_PORT:-5070} -m "$CALLS" \
  -sf /tmp/uac_siprec_pcap.xml \
  -trace_msg   -message_file /logs/sipp_messages.log \
  -trace_err   -error_file   /logs/sipp_errors.log \
  -trace_screen -screen_file /logs/sipp_screen.log \
  > /dev/null 2>&1 || { echo "❌ sipp 呼叫失败,看 sipp-logs/sipp_errors.log"; exit 1; }
echo "呼叫完成"

sleep 2

echo ""
echo "=== 日志文件 ==="
ls -la "$LOGDIR"

echo ""
echo "=== 最新一条 MySQL 元数据 ==="
docker exec oreka-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" siprec -e "SELECT id, caller_number, callee_number, duration_ms, start_time, end_time FROM recording_metadata_'"$(date +%Y%m)"' ORDER BY id DESC LIMIT 1;"' 2>/dev/null | grep -v Warning

echo ""
echo "=== 录音文件(最近 3 个)==="
find "$PWD/recordings" -name "*.pcap" -type f -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn | head -3 | cut -d' ' -f2- | xargs -r ls -la

echo ""
echo "=== siprec-server 最新 3 条日志 ==="
docker logs siprec-server 2>&1 | tail -3

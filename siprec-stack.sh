#!/usr/bin/env bash
# siprec-stack.sh —— 一键管理 SIPREC 录音栈(drachtio + rtpengine + siprec)
# 用法: ./siprec-stack.sh {start|stop|restart|status|logs}
#
# 设计说明:
#   - 宿主机网络(--network host):录音对 NAT 敏感,与测试环境行为一致
#   - drachtio 控制面映射到宿主机 9023(容器内 9022),SIP 监听 5060/udp
#   - rtpengine 控制面 22222/udp,媒体端口 30000-40000/udp
#   - siprec 录音服务器连接 127.0.0.1:9023(drachtio) 和 127.0.0.1:22222(rtpengine)
#   - 元数据落库连 127.0.0.1:3306 的 oreka-mysql(siprec 库)
set -euo pipefail
cd "$(dirname "$0")"

DRACHTIO_IMG="siprec/drachtio-server:202610-0.9.11"
RTPENGINE_IMG="siprec/rtpengine:202610-27.0.0"
SIPREC_IMG="siprec/siprec-server:202610-2.0.0"

RTP_WORKDIR="$PWD/recordings"   # rtpengine 录音文件输出目录
mkdir -p "$RTP_WORKDIR"

log() { echo "[siprec-stack] $*"; }

# ---------- 镜像准备 ----------
ensure_images() {
  # 录音服务器本体镜像(本地构建,若不存在)
  if ! docker image inspect "$SIPREC_IMG" >/dev/null 2>&1; then
    log "构建 $SIPREC_IMG ..."
    docker build -f Dockerfile -t "$SIPREC_IMG" .
  fi
}

# ---------- 启动 ----------
start() {
  ensure_images

  # 1) drachtio:SIP 信令。控制面容器内 9022 -> 宿主 9023;SIP 监听 udp/5060
  if ! docker ps --format '{{.Names}}' | grep -qx drachtio; then
    docker rm -f drachtio >/dev/null 2>&1 || true
    log "启动 drachtio ..."
    docker run -d --name drachtio --restart unless-stopped \
      --network host \
      "$DRACHTIO_IMG" \
      drachtio --contact "sip:*;transport=udp" --loglevel info --port 9023
  else
    log "drachtio 已在运行"
  fi

  # 2) rtpengine:录音媒体。控制面 22222/udp,媒体 30000-40000/udp
  if ! docker ps --format '{{.Names}}' | grep -qx rtpengine; then
    docker rm -f rtpengine >/dev/null 2>&1 || true
    log "启动 rtpengine ..."
    docker run -d --name rtpengine --restart unless-stopped \
      --network host \
      -v "$RTP_WORKDIR:/tmp" \
      "$RTPENGINE_IMG" \
      rtpengine --interface 127.0.0.1 --listen-ng 127.0.0.1:22222 \
        --listen-http 127.0.0.1:9909 \
        --port-min 30000 --port-max 40000 --log-level 6
  else
    log "rtpengine 已在运行"
  fi

  # 等 drachtio 控制面就绪
  sleep 3

  # 3) siprec:录音服务器本体
  if ! docker ps --format '{{.Names}}' | grep -qx siprec-server; then
    docker rm -f siprec-server >/dev/null 2>&1 || true
    log "启动 siprec-server ..."
    docker run -d --name siprec-server --restart unless-stopped \
      --network host \
      -e NODE_CONFIG_ENV=production \
      -e DB_HOST=127.0.0.1 -e DB_PORT=3306 -e DB_USER=root \
      -e DB_PASSWORD=oreka123 -e DB_NAME=siprec \
      "$SIPREC_IMG"
  else
    log "siprec-server 已在运行"
  fi

  log "启动完成。status 查看状态。"
}

# ---------- 停止 ----------
stop() {
  for c in siprec-server rtpengine drachtio; do
    if docker ps -a --format '{{.Names}}' | grep -qx "$c"; then
      log "停止 $c"
      docker rm -f "$c" >/dev/null 2>&1 || true
    fi
  done
}

# ---------- 状态 ----------
status() {
  docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' \
    | grep -E 'NAMES|drachtio|rtpengine|siprec-server|siprec-web|oreka-mysql' || true
}

# ---------- 日志 ----------
logs() {
  docker logs -f --tail 100 siprec-server
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 2; start ;;
  status)  status ;;
  logs)    logs ;;
  *) echo "用法: $0 {start|stop|restart|status|logs}"; exit 1 ;;
esac

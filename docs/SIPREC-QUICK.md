# SIPREC 一页速查

> 详细版：`handoffs/DEVPSIPREC.md`

## 架构（5 容器，录音只需 4）

| 容器 | 作用 | 端口 |
|---|---|---|
| drachtio | SIP 信令 | 5060/udp |
| rtpengine | 媒体录音→pcap | 22222/udp, 30000-31000/udp |
| siprec-server | 解析元数据+控 rtpengine+写库 | 22223 |
| oreka-mysql | 元数据库 | 3306(127.0.0.1) |
| siprec-web | 查询/播放/看板/API（**不参与录音**） | 8444 |

compose：`~/drachtio-siprec-recording-server/docker-compose.yml` 管前 4 个（除 mysql）；mysql 在 `~/oreka/docker-compose.yml`。

## 启停

```bash
cd ~/oreka && docker compose up -d mysql                 # 1. 数据库先起
cd ~/drachtio-siprec-recording-server
docker compose up -d                                    # 2. 4 个容器
docker compose ps
docker compose stop                                     # 停（保留数据）
docker compose logs -f siprec-server
```

## 验证

```bash
./sipp-call.sh 1000 127.0.0.1 1 5      # 发 1 通 5 秒测试呼
./sipp-test.sh                          # 回归：录音+落库+日志

# 最新元数据
docker exec oreka-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" siprec \
 -e "SELECT id,caller_number,callee_number,duration_ms FROM recording_metadata_'"$(date +%Y%m)"' ORDER BY id DESC LIMIT 3;"'

# 在录数（心跳 30s 窗口）
docker exec oreka-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" siprec \
 -e "SELECT COUNT(*) FROM active_sessions WHERE last_heartbeat >= NOW(3)-INTERVAL 30 SECOND;"'
```

## 关键路径

```
recordings/pcaps/   原始 pcap（rtpengine 写）
recordings/flac/    冷归档
recordings/cache/   播放缓存（可删）
tools/pcap2audio.js                 pcap→WAV/MP3/FLAC（支持 PCMU+PCMA）
scripts/archive-recordings.sh       归档（30天→FLAC→删pcap）
scripts/migrate-metadata-columns.sh 表结构迁移（幂等）
docs/API-v1.md                      对外 API 文档
siprec-web/api-config.json          对外 Token（gitignored）
.env                                全部密钥（gitignored）
```

## 对外 API（Base `https://host:8444/api/v1`，Bearer Token）

```
GET  /health
GET  /recordings?caller=&callee=&tag=&startTime=&endTime=&durationOp=gt|lt|eq&duration=秒&page=&size=
GET  /recordings/{recordingId}                     # recordingId = YYYYMM_id
GET  /recordings/{id}/audio?fmt=wav|mp3|flac       # 支持 Range
GET  /recordings/{id}/download
PUT  /recordings/{id}/tag          {"tag":"..."}
PUT  /recordings/{id}/transcript   {"left":"...","right":"..."}
GET  /stats/active?detail=1
GET  /stats/summary?from=&to=
GET  /stats/storage
```

## 排障速查

| 现象 | 原因 → 处理 |
|---|---|
| rtpengine 反复重启，日志停在 DTLS | compose command 用了反斜杠续行 → 改 YAML 数组 |
| rtpengine exit 0 无日志 | 缺 `--foreground --log-stderr` |
| 无 pcap，`no spool directory configured` | 补 `--recording-dir /tmp --recording-method pcap` |
| `Failed to init websocket listener` + fe80 | 宿主机 veth 带 IPv6 link-local → 换网络/禁 veth IPv6 |
| 落库 `ECONNREFUSED 3306` | mysql 未发布端口 → oreka compose 加 `127.0.0.1:3306:3306` |
| WAV 单声道有声音 | 两腿 PCMA+PCMU → 确认转换日志 `(2 路 RTP)` |
| 声道按钮无效 | 必须用方案 B（独立 BufferSource 图） |
| 时间查询多出次日记录 | 前端改发 ISO，后端 `parseTs` 双格式；看 `[query]` 日志 |
| 跨月查询 SQL 报错 | UNION 参数需 `tables.flatMap(() => params)` |
| 归档后无法播放 | audio.js 有 flac fallback，确认 `recordings/flac/` 有对应文件 |

## 三条铁律

1. **rtpengine 必须**：`--foreground` + `--recording-dir /tmp --recording-method pcap`，compose 里 command 写数组
2. **时间全是 UTC**：DB 存 UTC，前端发 ISO 8601
3. **落库/心跳失败绝不阻断录音**（只记日志）

## 仓库

| 仓库 | 分支 | 说明 |
|---|---|---|
| `~/drachtio-siprec-recording-server` | `Localized` | 主项目 |
| `~/oreka` | `SpringOrkweb` | mysql+orkaudio |
| `~/rtpengine` | `debian13-build` (c52eaac，**未推送**) | debian13 构建 |

## 当前状态（2026-10-25）

容器全停（宿主刚重启）；数据完好（288 pcap/276MB）；镜像 `rtpengine:2.0.0-debian13` 可用。
恢复：先 oreka mysql，再 SIPREC compose，然后 `./sipp-test.sh`。

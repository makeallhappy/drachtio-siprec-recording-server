# SIPREC 对外 API v1(第三方对接)

> 面向第三方的查询/播放接口。鉴权使用静态 Token(配置文件),不走登录验证码。

## 基础信息

- Base URL:`https://<host>:8444/api/v1`
- 协议:HTTPS(证书由 AVAYA CA 签发;客户端需信任该 CA,或用 `-k` 测试)
- 统一响应:`{ "code": 0, "message": "ok", "data": ... }`,`code=0` 表示成功

## 鉴权

所有 `/recordings*` 接口需要请求头:

```
Authorization: Bearer <API_TOKEN>
```

Token 配置在 `siprec-web/api-config.json`:

```json
{ "apiToken": "用 openssl rand -hex 32 生成" }
```

> 该文件已在 .gitignore 中(不入库);容器启动时以只读方式挂载到 `/app/api-config.json`。
> 也可用环境变量 `API_TOKEN` 覆盖。修改后重启 siprec-web 容器生效。

错误响应:
| HTTP | code | 含义 |
|---|---|---|
| 401 | 40100 | token 缺失或错误 |
| 400 | 40001 | recordingId 格式错误 |
| 404 | 40401 | 录音不存在 / 无音频文件 |
| 500 | 50000 | 服务端错误 |

## 1. 查询录音列表

```
GET /recordings
```

| 参数 | 类型 | 说明 |
|---|---|---|
| page | int | 页码,从 1 开始(默认 1) |
| size | int | 每页条数,1-200(默认 20) |
| caller | string | 主叫过滤(号码/URI/姓名,模糊匹配) |
| callee | string | 被叫过滤(同上) |
| startTime | long | 开始时间下限(毫秒时间戳) |
| endTime | long | 开始时间上限(毫秒时间戳) |
| minDuration | int | 最短通话时长(毫秒) |
| maxDuration | int | 最长通话时长(毫秒) |
| sort | string | 排序字段,默认 `start_time` |
| order | string | `asc` / `desc`(默认 desc) |

响应示例:

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "total": 25,
    "page": 1,
    "size": 20,
    "items": [
      {
        "recordingId": "202610_25",
        "callerNumber": "1000",
        "callerName": null,
        "calleeNumber": "101",
        "calleeName": null,
        "startTime": "2026-10-19T01:11:38.000Z",
        "endTime": "2026-10-19T01:11:48.000Z",
        "durationMs": 10019,
        "recordingSessionId": "XoM2pKdFR8C3eX33qJKcww==",
        "originalCallId": "10-1@127.0.1.1"
      }
    ]
  }
}
```

> `recordingId` 是对外唯一标识,格式 `<YYYYMM>_<id>`(内部自动映射到分月表,调用方无需关心)。

## 2. 录音详情

```
GET /recordings/{recordingId}
```

返回完整元数据,额外包含 `callerAor`、`calleeAor`、`sdp`、`metadataXml`(SIPREC rs-metadata 原文)。

## 3. 音频流(播放)

```
GET /recordings/{recordingId}/audio?fmt=wav|mp3|flac
```

- 默认 `fmt=wav`(8kHz 立体声:左声道=主叫,右声道=被叫;全平台兼容)
- 支持 HTTP Range:响应 `206 Partial Content`,可直接用于网页播放器拖动进度
- 响应头:`Content-Type: audio/wav`、`Accept-Ranges: bytes`、`Cache-Control: private, max-age=3600`

## 4. 音频下载

```
GET /recordings/{recordingId}/download?fmt=wav|mp3|flac
```

同音频流,额外返回 `Content-Disposition: attachment; filename="..."`。

## 5. 健康检查(无需 Token)

```
GET /health
```

```json
{ "code": 0, "message": "ok", "data": { "status": "up" } }
```

## curl 示例

```bash
TOKEN=<你的 API Token>
BASE=https://<host>:8444/api/v1

# 查询最近 10 条
curl -sk -H "Authorization: Bearer $TOKEN" "$BASE/recordings?size=10"

# 按主叫+时间过滤
curl -sk -H "Authorization: Bearer $TOKEN" \
  "$BASE/recordings?caller=1000&startTime=1760000000000&endTime=1760999999999"

# 详情
curl -sk -H "Authorization: Bearer $TOKEN" "$BASE/recordings/202610_25"

# 播放音频(浏览器/播放器直接打开,注意鉴权头需由客户端携带)
curl -sk -H "Authorization: Bearer $TOKEN" -o call.wav \
  "$BASE/recordings/202610_25/audio?fmt=wav"

# 下载 mp3
curl -sk -H "Authorization: Bearer $TOKEN" -OJ \
  "$BASE/recordings/202610_25/download?fmt=mp3"
```

## 与内部接口的区别

| 项目 | 内部 `/api/*` | 对外 `/api/v1/*` |
|---|---|---|
| 鉴权 | 验证码 + JWT | 静态 Bearer Token |
| 标识 | `/recordings/:table/:id`(暴露分表) | `/recordings/:recordingId`(隐藏分表) |
| 响应 | 直接返回数据 | 统一 `{code,message,data}` |
| 用途 | WEB 页面 | 第三方系统对接 |


## 6. 实时统计:正在录音数

```
GET /stats/active?detail=1
```

基于 `active_sessions` 心跳表:**每 10 秒**刷新一次 `last_heartbeat`,统计时只认 **30 秒内**有心跳的会话(容忍 3 次心跳丢失)。

```json
{
  "code": 0, "message": "ok",
  "data": {
    "activeRecordings": 1,
    "heartbeatIntervalSec": 10,
    "activeWindowSec": 30,
    "checkedAt": "2026-10-18T18:09:55.296Z",
    "sessions": [
      {
        "sessionKey": "recording_metadata_202610_27",
        "callId": "1-1@127.0.1.1",
        "callerNumber": "1000",
        "calleeNumber": "101",
        "startTime": "2026-10-18T18:09:31.000Z",
        "lastHeartbeat": "2026-10-18T18:09:55.000Z",
        "elapsedSec": 24
      }
    ]
  }
}
```

> 不加 `detail=1` 只返回计数,开销极小,可高频轮询(建议 ≥10 秒)。
> 相比"用元数据 `end_time IS NULL` 推断",心跳表能自动排除进程崩溃留下的僵尸记录。

## 7. 汇总统计

```
GET /stats/summary?from=<ms>&to=<ms>
```

`from`/`to` 为毫秒时间戳(按 `start_time` 过滤),可省略表示全部。

```json
{
  "code": 0, "message": "ok",
  "data": {
    "total": 25,
    "completed": 25,
    "inProgress": 0,
    "totalDurationMs": 194645,
    "avgDurationMs": 7786,
    "from": "2026-10-17T18:10:13.000Z",
    "to": null,
    "tables": 1
  }
}
```

> `inProgress` 是元数据层面 `end_time IS NULL` 的计数(历史统计用);**实时在录数请用 `/stats/active`**。


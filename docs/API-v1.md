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


## 8. 元数据字段扩展（2026-10）

### 新增字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `thirdpty_append` | varchar(255) | **第三方应用标签**，可用 `?tag=` 过滤 |
| `left_channel_txt` | mediumtext | **左声道（主叫）转写文本** |
| `right_channel_txt` | mediumtext | **右声道（被叫）转写文本** |
| `audio_size_bytes` | bigint unsigned | 音频文件大小（归档时回填） |
| `archived` | tinyint(1) | 是否已冷归档（pcap 已转 FLAC 并删除） |

列表中返回 `thirdPartyTag` / `archived` / `audioSizeBytes`；详情额外返回 `leftChannelText` / `rightChannelText`。

### 标签写入

```
PUT /recordings/{recordingId}/tag
Content-Type: application/json

{ "tag": "crm-12345" }
```

```json
{ "code": 0, "message": "ok",
  "data": { "recordingId": "202610_27", "thirdPartyTag": "crm-12345" } }
```

按标签过滤:`GET /recordings?tag=crm-12345`

### 转写文本写入

```
PUT /recordings/{recordingId}/transcript
Content-Type: application/json

{ "left": "主叫说话内容", "right": "被叫说话内容" }
```

可只传其一;`updated` 返回实际更新字段数。

### 检索优化

主叫/被叫过滤已改为 **ngram 全文索引 + LIKE 兜底**:

- 子串可命中（如 `caller=000` 能匹配 `1000`）
- 中文同样支持（ngram 2-gram）
- 走 `ft_caller` / `ft_callee` 索引,数据量大时明显快于纯 LIKE

### 时区约定

数据库内所有 `DATETIME` 均按 **UTC** 存储与读取（连接显式 `timezone: 'Z'`）。
对外接口返回 ISO 8601 字符串（带 `Z`），第三方自行转换本地时区。

### 索引一览

| 索引 | 用途 |
|---|---|
| `idx_start_time` | 时间范围查询 |
| `idx_end_time` | 未结束/时长统计 |
| `idx_recording_session_id` | 会话回溯 |
| `idx_caller_number` / `idx_callee_number` | 精确/前缀 |
| `idx_thirdpty_append` | 按第三方标签过滤 |
| `ft_caller` / `ft_callee` | ngram 全文（子串/中文） |


## 9. recordingId 计算规则

`recordingId` **不是数据库字段**,而是由"月份 + 表内自增 id"拼出来的对外标识:

```
recordingId = <YYYYMM>_<id>
```

| 组成 | 来源 |
|---|---|
| `YYYYMM` | 分月表名 `recording_metadata_YYYYMM` 的后 6 位 |
| `id` | 该表的自增主键 `id` |

示例:

| 数据库位置 | recordingId |
|---|---|
| 表 `recording_metadata_202610`,行 `id=27` | `202610_27` |
| 表 `recording_metadata_202611`,行 `id=5` | `202611_5` |

### 反解规则(服务端)

```
取最后一个下划线:
  前缀 = "202610"  -> 表名 = "recording_metadata_" + 前缀
  后缀 = "27"      -> id = 27
```

### 特性

- **对外唯一**:月份 + 表内自增 id,跨月不重复(前提:分月表不被删除重建)
- **隐藏分表细节**:调用方无需知道 MySQL 按月份分表,也不用拼表名
- **不可自造**:必须使用查询接口返回的值;格式错误返回 `400/40001`

### 与其他标识的区别

| 标识 | 来源 | 是否对外唯一 | 用途 |
|---|---|---|---|
| `recordingId` | 月份 + id 计算 | ✅ | **对外主键**,API 路径参数 |
| `originalCallId` | SIP Call-ID | 一般唯一 | 关联 rtpengine 的 pcap 录音文件 |
| `recordingSessionId` | SIPREC rs-metadata XML | ❌ 不保证(某些 SBC 复用固定值) | 与 PBX/SBC 侧对账 |
| `sessionId` | 本地生成的 UUID | 表内唯一 | 内部排查日志 |

> 提示:调用方应把 `recordingId` 当作**不透明字符串**保存和传递,不要解析其结构。
> 若未来分表策略调整,结构可能变化,但接口语义不变。


## 10. 存储统计

```
GET /stats/storage
```

返回录音各目录占用 + 底层文件系统容量(宿主机磁盘) + 低空间标记。

```json
{
  "code": 0, "message": "ok",
  "data": {
    "pcapBytes": 1352148, "pcapFiles": 28,
    "flacBytes": 195174,  "flacFiles": 4,
    "cacheBytes": 625571, "cacheFiles": 6,
    "tmpBytes": 0, "tmpFiles": 0,
    "totalRecordingBytes": 2172893,
    "disk": {
      "totalBytes": 187926462464,
      "freeBytes": 71670566912,
      "usedPercent": 61.9,
      "lowSpace": false,
      "lowSpaceThresholdPercent": 10
    },
    "recordingRoot": "/recordings",
    "checkedAt": "2026-10-18T18:49:51.014Z"
  }
}
```

| 字段 | 说明 |
|---|---|
| `pcapBytes/Files` | 原始录音(pcap)占用与文件数 |
| `flacBytes/Files` | 冷归档 FLAC 占用 |
| `cacheBytes/Files` | 播放转码缓存(可清理) |
| `tmpBytes/Files` | 归档中间文件(正常应为 0) |
| `disk.totalBytes/freeBytes` | 底层文件系统总容量/可用(即宿主机磁盘) |
| `disk.usedPercent` | 磁盘使用率(%) |
| `disk.lowSpace` | 可用空间 < 10% 时为 `true`,可据此告警 |

> 实现说明:容器通过 bind mount 看到的是同一份文件系统,因此 `du`(目录占用)与 `statfs`(磁盘容量)都反映宿主机真实数据。
> 轮询建议 ≥ 60 秒(目录递归统计有 I/O 开销,文件量大时尤甚)。


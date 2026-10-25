# drachtio-siprec-recording-server ![Build Status](https://github.com/drachtio/drachtio-siprec-recording-server/workflows/CI/badge.svg)

> **本项目由 AI 编程**
>
> 本仓库在开源项目 drachtio-siprec-recording-server 基础上的二次开发（分月表元数据落库、查询 WEB、双轨波形播放等定制功能）由 AI 辅助完成。原始项目版权归原作者所有，见下方英文说明。

---

## 系统架构(从 SIP INVITE 到落库、查询)

### 一、组件总览(5 个常驻容器,宿主机网络,均 `--restart unless-stopped`)

| 容器 | 角色 | 关键端口 | 镜像 |
|---|---|---|---|
| **drachtio** | SIP 信令服务器 | 5070/udp(SIP), 9023(控制) | drachtio/drachtio-server |
| **rtpengine** | 媒体录音引擎 | 22222/udp(NG 控制), 30000-40000/udp(RTP) | drachtio/rtpengine |
| **siprec-server** | 录音服务器本体(Node) | 22223(本地 DTMF) | 本地构建 `siprec-server` |
| **oreka-mysql** | 数据库 | 3306 | mysql:8.0 |
| **siprec-web** | 查询 WEB(Node + Vue3) | 8444(HTTPS) | 本地构建 `siprec-web` |

### 二、录音数据流(INVITE → 落库)

```
① SIP INVITE(SIPREC 客户端:PBX / sipp)
   │  INVITE sip:X@<host>:5070
   │  Content-Type: multipart/mixed
   │  ├─ application/sdp        (caller 腿 + callee 腿 两路 SDP)
   │  └─ application/rs-metadata(录音会话元数据 XML)
   ▼
┌────────────────────────────────────────────┐
│ drachtio (5070/udp)                        │  收 SIP 信令
└────────────────────────────────────────────┘
   │  控制面转发(9023)
   ▼
┌────────────────────────────────────────────┐
│ siprec-server (app.js)                     │
│  • 校验是否 SIPREC(app.js srf.use 中间件: │
│  │    Content-Type 须为 multipart/mixed,   │
│  │    否则回 488 拒绝;                     │
│  │    rs-metadata 存在性由 payload-parser   │
│  │    在解析阶段进一步校验)                 │
│  • payload-parser 解析 XML:caller/callee   │
│    aor/name/number、recordingSessionId、    │
│    原始 Call-ID                             │
│  ├─► ② onCallStart():INSERT 元数据到 MySQL │
│  │      siprec.recording_metadata_YYYYMM    │
│  │      (end_time/duration 暂 NULL,        │
│  │       original_call_id = SIP Call-ID)   │
│  └─► ③ NG 协议控制 rtpengine 建两路端点:   │
│        offer/answer(127.0.0.1:22222),      │
│        flag 'record call'                   │
└────────────────────────────────────────────┘
   │  NG 控制(offer/answer/delete)
   ▼
┌────────────────────────────────────────────┐
│ rtpengine (22222/udp 控制)                 │
│  • 接管两路 RTP 媒体流(30000-40000/udp)   │
│  • ④ 边转发边录音 → pcap 落盘:             │
│    recordings/pcaps/<callid>-<rand>.pcap   │
│    (@ 编码为 %40;recording-method=pcap)    │
└────────────────────────────────────────────┘
   ▲
   │ RTP 音频流(PCMA/G.711,主叫+被叫两路)
(通话进行中……)
   │  ⑤ BYE / destroy
   ▼
┌────────────────────────────────────────────┐
│ siprec-server  onCallEnd()                 │
│  • rtpengine delete(清理端点)              │
│  └─► UPDATE 元数据:回填 end_time +         │
│      duration_ms(TIMESTAMPDIFF)            │
└────────────────────────────────────────────┘
```

录音完成后数据齐了:
- **MySQL** `siprec.recording_metadata_YYYYMM` 一行:caller/callee 号码、起止时间、时长、`original_call_id`、SDP、rs-metadata XML
- **磁盘** `recordings/pcaps/<callid>-<rand>.pcap`:双声道 RTP(PCMA)

### 三、查询/播放链路(siprec-web)

```
用户浏览器(HTTPS 8444,Vue3 SPA)
   │  ① 登录:验证码(svg-captcha)+ 密码
   │     → bcrypt 校验 oreka.orkuser → 签 JWT
   ▼
┌────────────────────────────────────────────┐
│ siprec-web (Express,JWT 保护)              │
│  ② 查询 GET /api/recordings                │
│     → 跨月 UNION recording_metadata_* 分表 │
│     → 主叫/被叫/时间/时长过滤 → 分页       │
│  ③ 播放/下载 GET /api/recordings/:t/:id/audio│
│     → 读该行 original_call_id              │
│     → 匹配 recordings/pcaps/<callid>-*.pcap│
│     → tools/pcap2audio.js(纯 Node 零依赖):│
│        pcap → 拆 RTP(PT=8 PCMA)按 SSRC 分腿│
│        → G.711 A-law 解码 → 双声道 WAV     │
│     → 容器内 ffmpeg → 可转 MP3/FLAC        │
│     → recordings/cache/ 缓存(不重复转)    │
│     → HTTP Range 流式返回(206 拖动)       │
└────────────────────────────────────────────┘
   ▼
浏览器渲染:
  • wavesurfer.js 双轨波形(splitChannels)
    左声道=主叫(绿),右声道=被叫(橙)
  • Web Audio ChannelSplitter + GainNode 分路播放
    (双轨 / 只听主叫 / 只听被叫)
```

### 四、关键技术决策

| 决策 | 原因 |
|---|---|
| 宿主机网络 | SIP/RTP 对 NAT 敏感,host 网络最稳(和测试一致) |
| 分月表 `recording_metadata_YYYYMM` | 追加型时序数据,分表好维护;查询按 UNION 拼 |
| `original_call_id` 关联 pcap | rtpengine 文件名用 SIP Call-ID,落库存它才能找到录音文件 |
| 落库失败不阻断录音 | onCallStart/onCallEnd 的 catch 只 log,录音主流程绝不被 DB 拖垮 |
| rtpengine(不用 freeswitch) | 架构更轻;redis 也不需要(那是 freeswitch 模式缓存 SDP 用的) |
| WAV 播放 | 全浏览器含 iOS 通吃;libflacjs 是 Node 库会导致白屏,已回退 |
| JWT + 验证码,复用 oreka.orkuser | 认证从 orekaweb 平移,admin/admin 直接可用 |
| AVAYA CA 证书(8444 HTTPS) | 复用 ork.p12,内网浏览器信任 AVAYA CA 则绿锁 |

### 五、一键运维

```bash
./siprec-stack.sh start    # 拉起 drachtio + rtpengine + siprec-server
./siprec-stack.sh stop     # 停掉
./siprec-stack.sh restart  # 重启
./siprec-stack.sh status   # 看 5 容器状态
./siprec-stack.sh logs     # 跟踪录音服务器日志

./sipp-call.sh 1000        # 发 SIPREC 测试呼叫(指定被叫号码)
./sipp-test.sh             # 固定回归测试 + 全链路验证(日志/落库/录音)

node tools/pcap2audio.js <pcap|目录> [--mix] [--mp3|--flac] [--all]
                           # 手动把 pcap 转成 WAV/MP3/FLAC
```

查询 WEB:`https://<host>:8444`(默认 admin/admin,首次登录请改密码)。

---

# 原始项目说明(英文)

An open source implementation of a SIPREC recording server based on [dractio](https://drachtio.org) and using either
* [rtpengine](https://github.com/sipwise/rtpengine) or
* [Freeswitch](https://freeswitch.com/)
* [Asterisk](https://asterisk.org)
as the back-end recording system.

## Install

This application requires a [drachtio SIP server](https://github.com/drachtio/drachtio-server) to be installed in your network.  Please refer to [the build and installation instructions here](https://drachtio.org/docs/drachtio-server), or [here](https://github.com/drachtio/drachtio-server).

* Copy either `config/default.json.example-rtpengine` or `config/default.json.example-freeswitch` depending on which back-end media server you want to use (it is an either-or choice: you can't mix them) to `config/local.json` and edit to provide the IP  addresses/ports for your configuration (i.e., location of the drachtio server, and either the rtpengine or freeswitch/asterisk media server). 
* Run `npm install`
* Run `node app` to run.
* Configure your SBC to send SIPREC invites to your drachtio server.

## Using rtpengine as the media server
When using rtpengine as the recorder, there is minimal configuration you will need to do on the rtpengine server -- a vanilla install will do.  The application will use the [ng control protocol](https://github.com/sipwise/rtpengine#the-ng-control-protocol), so you will need to open the UDP port on the rtpengine server to allow commands from the server running the drachtio-siprec-recording-server application.

Also, rtpengine generates recordings in pcap file format, so you will need to do some post-processing to deliver a flac, wav, mp3 or whatever final format you prefer.

## Using Freeswitch as the media server
When using Freeswitch, a bit of configuration is needed on the Freeswitch server.  Specifically, you must implement a dialplan that:
* allows unauthenticated INVITEs from the drachtio server
* hairpins incoming calls back to the sender, by using the Freeswitch [bridge application](https://freeswitch.org/confluence/display/FREESWITCH/mod_dptools%3A+bridge) to send the B leg INVITE back to the source of the A leg INVITE
* exports the custom 'X-Return-Token' header from the A leg to the B leg, and finally
* makes a recording of the call.

An example snippet of a dialplan that does the trick looks like this:
```xml
  <extension name="hairpin_and_record">
    <condition field="${sip_h_X-Return-Token}" expression="^(.+)$">
      <action application="export" data="sip_h_X-Return-Token=${sip_h_X-Return-Token}" />
      <action application="export" data="_nolocal_jitterbuffer_msec=100"/>
      <action application="set" data="RECORD_STEREO=true"/>
      <action application="set" data="call_id=${strftime(%Y%m%d_%H%M%S)}_${sip_from_tag}"/>
      <action application="set" data="outfile=$${base_dir}/recordings/${call_id}.wav"/> 
      <action application="record_session" data="${outfile}"/>
      <action application="set" data="hangup_after_bridge=true"/> 
      <action application="bridge" data="sofia/external/${destination_number}@${network_addr}"/>
    </condition>
  </extension>
```
For an example docker image that implements, see [davehorton/freeswitch-hairpin](https://hub.docker.com/r/davehorton/freeswitch-hairpin/).

> Note: when using Freeswitch, the application requires access to a redis server.  redis is used to track and correlate the A and B call legs, using the X-Return-Token header mentioned above.  When using rtpengine as the back-end, redis not required.

## Using Asterisk as media server instead of Freeswitch
We can mimic the same behavior with Asterisk. For this to work we need to leave the 'config/local.json' as it is for freeswitch. Asterisk will receive a call and send another one back to drachtio sip server. The same steps described above can be done in Asterisk by modifying the pjsip.conf and extensions.conf files:

1- Allows authenticated INVITEs from drachtio server. Add these settings to your 'pjsip.conf' file:
```
[drachtio_in]
type=endpoint
context=siprec
disallow=all
allow=ulaw
allow=alaw
allow=g729
transport=transport-udp

[drachtio_out]
type=endpoint
context=siprec
disallow=all
allow=ulaw
allow=alaw
allow=g729
transport=transport-udp
aors=drachtio_out

[drachtio_in]
type=identify
endpoint=drachtio_in
match=<IP HERE>

[drachtio_out]
type=aor
contact=sip:<IP HERE>:5070
```
2- Hairpin the incoming call back to the server. Add these setings to your 'extensions.conf" file:
```
[siprec]
exten => _[+*#0-9]!,1,NoOp(Receiving call from drachtio)
exten => _[+*#0-9]!,n,Set(XReturnHeader=${PJSIP_HEADER(read,X-Return-Token)})
exten => _[+*#0-9]!,n,Progress()
;exten => _[+*#0-9]!,n,MixMonitor(${UNIQUEID}.wav)
;exten => _[+*#0-9]!,n,Monitor(wav,myfilename)
exten => _[+*#0-9]!,n,MixMonitor(${UNIQUEID}-mixed.wav,r(${UNIQUEID}-in.wav)t(${UNIQUEID}-out.wav))
exten => _[+*#0-9]!,n,Dial(PJSIP/${EXTEN}@drachtio_out,,b(addHeaders^addHeaderXRetHdr^1(${XReturnHeader})))
exten => _[+*#0-9]!,n,HangUp()


[addHeaders]
exten => addHeaderXRetHdr,1,Set(PJSIP_HEADER(add,X-Return-Token)=${ARG1})
same => n,Return()
```
### Using dockerized versions of drachtio and rtpengine

If you haven't built the [drachtio server](https://github.com/drachtio/drachtio-server) and rtpengine processes (and don't want to), you can run using these docker images:
* [rtpengine](https://hub.docker.com/r/davehorton/rtpengine)
* [drachtio-server](https://hub.docker.com/r/drachtio/drachtio-server)

For guidance, have a look at the test suite, which uses docker-compose to create a test environment, as an example [test/docker-compose-testbed.yaml](test/docker-compose-testbed.yaml).

## Interoperability
This application has been tested with the following SIPREC clients:
* Ribbon SBC 5200 (tested with Freeswitch back-end media server)
* OpenSIPS (tested with rtpengine and Freeswitch back-end media servers)
* Cisco Unified Border element (tested with rtpengine back-end media server)
* Oracle Enterprise Session Border Controller
## Test

`npm test` 

Note: docker is required to run the test cases

## How it works

The application receives the SIPREC INVITE from the SBC (or other SIPREC recording client), which will contain the multipart body with both SDP and XML metadata.  The application parses the SDP to retrieve the two media endpoints that will be streaming from the SDP.  What happens next is different depending on whether rtpengine or Freeswitch is being used.

When using rtpengine, the application creates two associated media endpoints on rtpengine (using the 'offer' and 'answer' commands in the ng protocol).  The two media endpoints created by rtpengine are then combined into a multipart body 200 OK response that is returned to the SBC.  The end result is that the caller media flows are directed to one of the rtpengin endpoints and the callee media flows to the other. The result is a recording made by rtpengine as if the caller and callee media flows were part of a call setup with rtpengine as a media proxy.

When using Freeswitch/Asterisk the same basic approach of sending the two media flows through Freeswitch/Asterisk as if it were a normal bridged call applies.  In this case, the application sends an INVITE to the Freeswitch/Asterisk with one of the SDPs parsed from the SIPREC body and Freeswitch/Asterisk is responsible for generating a B leg back towards the drachtio server.  Upon receving this B leg INVITE, the application answers 200 OK with remaining SDP parsed from the SIPREC body.  A final 200 OK answer back to the SIPREC client is then generated, using the two media endpoints allocated on the Freeswitch/Asterisk.  Media flows through the bridge connection and is recorded, as if caller were talking to callee through the Freeswitch/Asterisk.





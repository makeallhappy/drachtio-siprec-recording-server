#!/usr/bin/env bash
# sipp-call.sh —— 指定被叫号码发起 SIPREC 录音呼叫
# 用法:
#   ./sipp-call.sh <被叫号码> [目标地址] [通数] [通话秒数]
# 示例:
#   ./sipp-call.sh 1000                       # 呼叫 1000@127.0.0.1:5060,1 通,3 秒
#   ./sipp-call.sh 1000 172.16.40.24          # 指定地址
#   ./sipp-call.sh 1000 172.16.40.24 5 10     # 5 通,每通 10 秒
#
# 原理:动态生成 SIPREC 场景(被叫用 [service] 变量,-s 传入),带完整日志。
# 产出:sipp-logs/call_<号码>_<时间戳>_messages.log 等。
set -euo pipefail
cd "$(dirname "$0")"

CALLEE="${1:?用法: $0 <被叫号码> [目标地址] [通数] [通话秒数]}"
HOST="${2:-127.0.0.1}"
CALLS="${3:-1}"
DUR="${4:-3}"
PORT=5060

LOGDIR="$PWD/sipp-logs"
mkdir -p "$LOGDIR"
TS="$(date +%Y%m%d_%H%M%S)"
BASE="call_${CALLEE}_${TS}"
SCEN="$LOGDIR/${BASE}.xml"
PCAP_SRC="$PWD/test/scenarios/pcap/g711a.pcap"

# pcap 音频文件(场景里 nop play_pcap_audio 需要);没有就用项目自带的
if [ -f "$PCAP_SRC" ]; then
  PCAP_IN_CONTAINER="/tmp/scen/pcap/g711a.pcap"
else
  PCAP_IN_CONTAINER=""
fi

# ---------- 动态生成场景(被叫 = [service],由 -s 传入) ----------
gen_scenario() {
cat > "$SCEN" <<XML
<?xml version="1.0" encoding="ISO-8859-1" ?>
<!DOCTYPE scenario SYSTEM "sipp.dtd">
<scenario name="SIPREC call to ${CALLEE}">
  <send retrans="500">
    <![CDATA[

      INVITE sip:[service]@[remote_ip]:[remote_port] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: sipp <sip:sipp@[local_ip]:[local_port]>;tag=[pid]SIPpTag09[call_number]
      To: [service] <sip:[service]@[remote_ip]:[remote_port]>
      Call-ID: [call_id]
      CSeq: 1 INVITE
      Contact: <sip:[local_ip]:[local_port]>
      Max-Forwards: 70
      Subject: siprec Test
      Content-Type: multipart/mixed; boundary=690DEB64
      Content-Length: [len]

      --690DEB64
      Content-Type: application/sdp

      v=0
      o=user1 53655765 2353687637 IN IP[local_ip_type] [local_ip]
      s=-
      c=IN IP[local_ip_type] [local_ip]
      t=0 0
      m=audio [auto_media_port] RTP/AVP 8
      c=IN IP[local_ip_type] [local_ip]
      a=rtpmap:8 PCMA/8000
      a=direction:both
      a=sendonly
      a=label:a_leg
      m=audio 60000 RTP/AVP 8
      c=IN IP[local_ip_type] [local_ip]
      a=rtpmap:8 PCMA/8000
      a=direction:both
      a=sendonly
      a=label:b_leg

      --690DEB64
      Content-Type: application/rs-metadata
      Content-Disposition: recording-session

      <?xml version="1.0" encoding="UTF-8"?>
        <recording xmlns='urn:ietf:params:xml:ns:recording:1'>
          <datamode>complete</datamode>
          <session session_id="XoM2pKdFR8C3eX33qJKcww==">
            <sipSessionID>hvij5wK4Wx</sipSessionID>
          </session>
          <participant participant_id="omFyWlFETEyFz/KXNLe4iQ==">
          <nameID aor="sip:${CALLEE}@[remote_ip]"/>
          </participant>
          <participant participant_id="fLbZzLMgRXGp+F5w0hOt6w==">
            <nameID aor="sip:101@[remote_ip]"/>
          </participant>
          <stream stream_id="1LiAtnDVR9m469/0L4bwCA==" session_id="XoM2pKdFR8C3eX33qJKcww==">
          <label>1</label>
          </stream>
          <stream stream_id="WJgj5uxeRH+nwUah02dWqg==" session_id="XoM2pKdFR8C3eX33qJKcww==">
          <label>2</label>
          </stream>
        </recording>

      --690DEB64--

    ]]>
  </send>

  <recv response="100" optional="true"></recv>
  <recv response="180" optional="true"></recv>
  <recv response="200" rtd="true" crlf="true"></recv>

  <send>
    <![CDATA[

      ACK sip:[service]@[remote_ip]:[remote_port] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: sipp <sip:sipp@[local_ip]:[local_port]>;tag=[pid]SIPpTag09[call_number]
      To: [service] <sip:[service]@[remote_ip]:[remote_port]>[peer_tag_param]
      Call-ID: [call_id]
      CSeq: 1 ACK
      Contact: sip:sipp@[local_ip]:[local_port]
      Max-Forwards: 70
      Content-Length: 0

    ]]>
  </send>

  <!-- 播放预录的 RTP 音频(rtpengine 才有媒体可录) -->
  <nop>
    <action>
      <exec play_pcap_audio="/tmp/scen/pcap/g711a.pcap"/>
    </action>
  </nop>

  <pause milliseconds="$((DUR * 1000))"/>

  <send retrans="500">
    <![CDATA[

      BYE sip:[service]@[remote_ip]:[remote_port] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: sipp <sip:sipp@[local_ip]:[local_port]>;tag=[pid]SIPpTag09[call_number]
      To: [service] <sip:[service]@[remote_ip]:[remote_port]>[peer_tag_param]
      Call-ID: [call_id]
      CSeq: 1 BYE
      Contact: sip:sipp@[local_ip]:[local_port]
      Max-Forwards: 70
      Content-Length: 0

    ]]>
  </send>

  <recv response="200" crlf="true"></recv>

  <ResponseTimeRepartition value="10, 20, 30, 40, 50, 100, 150, 200"/>
  <CallLengthRepartition value="10, 50, 100, 500, 1000, 5000, 10000"/>
</scenario>
XML
}

gen_scenario
echo "=== 呼叫 sip:${CALLEE}@${HOST}:${PORT}(${CALLS} 通,每通约 ${DUR} 秒)==="

docker run --rm --network host \
  -v "$LOGDIR:/logs" \
  -v "$PWD/test/scenarios:/tmp/scen" \
  drachtio/sipp:latest sipp "${HOST}:${PORT}" -m "$CALLS" \
  -sf "/logs/${BASE}.xml" -s "$CALLEE" \
  -trace_msg    -message_file "/logs/${BASE}_messages.log" \
  -trace_err    -error_file   "/logs/${BASE}_errors.log" \
  -trace_screen -screen_file  "/logs/${BASE}_screen.log" \
  > /dev/null 2>&1 || { echo "❌ 呼叫失败,看 $LOGDIR/${BASE}_errors.log"; exit 1; }

echo "呼叫完成。日志:"
ls -la "$LOGDIR/${BASE}"_* 2>/dev/null

sleep 2
echo ""
echo "=== 最新一条 MySQL 元数据 ==="
docker exec oreka-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" siprec -e "SELECT id, caller_number, callee_number, duration_ms FROM recording_metadata_'"$(date +%Y%m)"' ORDER BY id DESC LIMIT 1;"' 2>/dev/null | grep -v Warning

echo ""
echo "=== 实际发出的 INVITE 头(确认被叫)==="
grep -m1 -A3 "INVITE sip:" "$LOGDIR/${BASE}_messages.log" 2>/dev/null || echo "(messages 日志见上方路径)"

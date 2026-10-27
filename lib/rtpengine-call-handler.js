const parseSiprecPayload = require('./payload-parser');
const constructSiprecPayload = require('./payload-combiner');
const {getAvailableRtpengine} = require('./utils');
const store = require('./metadata-store');
const events = require('./events');
const registry = require('./call-registry');
const { v4 } = require('uuid');
const debug = require('debug')('drachtio:siprec-recording-server');

module.exports = (req, res) => {
  const callid = req.get('Call-ID');
  const from = req.getParsedHeader('From');
  const totag = v4();
  const logger = req.srf.locals.logger.child({callid});
  const opts = {
    req,
    res,
    logger,
    callDetails: {
      'call-id': callid,
      'from-tag': from.params.tag
    }
  };

  logger.info(`received SIPREC invite: ${req.uri}`);
  const rtpEngine = getAvailableRtpengine();

  parseSiprecPayload(opts)
    .then((o) => {
      // 元数据持久化:INVITE 建立时插入一条(end_time/duration 结束时回填)
      o.startTime = Date.now();
      // 用 SIP Call-ID 关联 rtpengine 的 pcap 文件名(<callid>-<random>.pcap)
      if (!o.originalCallId) o.originalCallId = callid;
      return store.onCallStart(o)
        .then((ref) => {
          o.dbRef = ref;
          // 登记活跃会话(心跳表),失败不影响录音
          return store.startActiveSession(o, ref)
            .catch((err) => logger.error(`startActiveSession failed: ${err.message}`))
            .then(() => o);
        })
        .catch((err) => {
          // 落库失败不阻断录音
          logger.error(`metadata onCallStart failed (continuing): ${err.message}`);
          return o;
        });
    })
    .then((o) => {
      // 事件推送:此时元数据已落库、活跃会话已登记(失败时字段可为空,不阻断)
      events.publish('call_start', {
        callId: callid,
        sessionId: o.sessionId || null,
        callerAor: o.caller && o.caller.aor ? o.caller.aor : null,
        callerName: o.caller && o.caller.name ? o.caller.name : null,
        calleeAor: o.callee && o.callee.aor ? o.callee.aor : null,
        calleeName: o.callee && o.callee.name ? o.callee.name : null,
        startTime: o.startTime || Date.now(),
        dbRef: o.dbRef || null,
      });
      return o;
    })
    .then(allocateEndpoint.bind(null, 'caller', rtpEngine, totag))
    .then(allocateEndpoint.bind(null, 'callee', rtpEngine, totag))
    .then(respondToInvite)
    .then((dlg) => {
      logger.info(`call connected successfully, using rtpengine at ${JSON.stringify(rtpEngine.remote)}`);
      // 登记到看门狗/中断控制表(session_key 与 active_sessions 一致)
      opts.key = opts.dbRef ? `${opts.dbRef.table}_${opts.dbRef.id}` : `call_${callid}`;
      registry.register(opts.key, {
        dlg,
        dbRef: opts.dbRef || null,
        callDetails: opts.callDetails,
        logger,
        rtpEngine,
        caller: opts.caller || null,
        callee: opts.callee || null,
        startedAt: opts.startTime || Date.now(),
      });
      dlg.on('modify', _onReinvite.bind(null, rtpEngine, logger, totag));
      return dlg.on('destroy', onCallEnd.bind(null, rtpEngine, opts));
    })
    .catch((err) => {
      logger.error(`Error connecting call: ${err}`);
    });
};

function _onReinvite(rtpEngine, logger, totag, req, res) {
  const callid = req.get('Call-ID');
  const from = req.getParsedHeader('From');
  const opts = {
    req,
    res,
    logger,
    callDetails: {
      'call-id': callid,
      'from-tag': from.params.tag,
    }
  };

  parseSiprecPayload(opts)
    .then(allocateEndpoint.bind(null, 'caller', rtpEngine, totag))
    .then(allocateEndpoint.bind(null, 'callee', rtpEngine, totag))
    .then((opts) => {
      const body = constructSiprecPayload(opts.rtpengineCallerSdp, opts.rtpengineCalleeSdp, opts.sdp1, opts.sdp2);
      return opts.res.send(200, {body});
    })
    .catch((err) => {
      logger.error(`Error connecting call: ${err}`);
    });

  logger.info(`received SIPREC Re-invite: ${req.uri}`);
}

function allocateEndpoint(which, rtpEngine, totag, opts) {
  // If audio is inactive, rtpengine will stop recording and there is no blank audio in record file.
  const sdp = (which === 'caller' ? opts.sdp1 : opts.sdp2).replace(/a=inactive\r\n/g, 'a=sendonly\r\n');
  const args = Object.assign({}, opts.callDetails, {
    sdp,
    'replace': ['origin', 'session-connection'],
    'transport protocol': 'RTP/AVP',
    'record call': 'yes',
    'DTLS': 'off',
    'ICE': 'remove',
    'SDES': 'off',
    'flags': ['media handover', 'port latching'],
    'rtcp-mux': ['accept'],
    'direction':  ['public', 'public'],
  });
  if (which === 'callee') Object.assign(args, {'to-tag': totag});

  debug(`callDetails: ${JSON.stringify(opts.callDetails)}`);
  debug(`rtpengine args for ${which}: ${JSON.stringify(args)}, sending to ${JSON.stringify(rtpEngine.remote)}`);
  return rtpEngine[which === 'caller' ? 'offer' : 'answer'](rtpEngine.remote, args)
    .then((response) => {
      if (response.result !== 'ok') {
        throw new Error('error connecting to rtpengine');
      }
      opts[which === 'caller' ? 'rtpengineCallerSdp' : 'rtpengineCalleeSdp'] = response.sdp;
      return opts;
    });
}

function respondToInvite(opts) {
  const srf = opts.req.srf;
  const payload = constructSiprecPayload(opts.rtpengineCallerSdp, opts.rtpengineCalleeSdp, opts.sdp1, opts.sdp2);
  return srf.createUAS(opts.req, opts.res, {localSdp: payload});
}

function onCallEnd(rtpEngine, opts) {
  const entry = opts.key ? registry.get(opts.key) : null;
  if (entry && entry.closed) return; // 幂等:看门狗与 BYE 可能同时触发
  if (entry) entry.closed = true;

  opts.logger.info('call ended');
  const reason = (entry && entry.reason) || 'bye';
  const target = entry || {
    key: opts.key,
    dbRef: opts.dbRef || null,
    callDetails: opts.callDetails || {},
    rtpEngine,
    logger: opts.logger,
    startedAt: opts.startTime || Date.now(),
  };
  return finalize(target, reason);
}

/** 统一收尾:回填元数据 + 删活跃行 + 关 rtpengine + 发事件(幂等由调用方保证) */
async function finalize(entry, reason) {
  const logger = entry.logger || console;
  const dbRef = entry.dbRef;
  const callId = (entry.callDetails && entry.callDetails['call-id']) || null;

  if (dbRef && dbRef.id) {
    await store.onCallEnd(dbRef, Date.now())
      .catch((err) => logger.error(`metadata onCallEnd failed: ${err.message}`));
    await store.endActiveSession(dbRef)
      .catch((err) => logger.error(`endActiveSession failed: ${err.message}`));
  }

  events.publish('call_end', {
    callId,
    durationMs: entry.startedAt ? Date.now() - entry.startedAt : null,
    dbRef: dbRef || null,
    reason,
  });

  try {
    if (entry.rtpEngine) {
      const response = await entry.rtpEngine.delete(entry.rtpEngine.remote, entry.callDetails || {});
      debug(`response to rtpengine delete: ${JSON.stringify(response)}`);
    }
  } catch (err) {
    logger.error(`rtpengine delete failed: ${err.message}`);
  }

  if (entry.key) registry.unregister(entry.key);
}

module.exports.finalizeEntry = finalize;

// Node v23+ 移除了废弃的 util.isRegExp/isDate/isObject 等;config@1.31.0 在 require 时的顶层代码
// (loadFileConfigs 深拷贝合并)就会调用它们,炸 TypeError: Utils.isXxx is not a function。
// 必须在 require('config') 之前打补丁(官方替代:util.types / Array.isArray)。
const util = require('util');
if (typeof util.isRegExp !== 'function') util.isRegExp = util.types.isRegExp.bind(util.types);
if (typeof util.isDate !== 'function') util.isDate = util.types.isDate.bind(util.types);
if (typeof util.isObject !== 'function') util.isObject = (v) => v !== null && typeof v === 'object';

const assert = require('assert');
const config = require('config');
const pino = require('pino');
const Srf = require('drachtio-srf');
const srf = new Srf() ;
const logger = srf.locals.logger = pino();
let callHandler;

if (config.has('drachtio.host')) {
  logger.info(config.get('drachtio'), 'attempting inbound connection');
  srf.connect(config.get('drachtio'));
  srf
    .on('connect', (err, hp) => { logger.info(`inbound connection to drachtio listening on ${hp}`);})
    .on('error', (err) => { logger.error(err, `Error connecting to drachtio server: ${err}`); });
}
else {
  logger.info(config.get('drachtio'), 'listening for outbound connections');
  srf.listen(config.get('drachtio'));
}

if (config.has('rtpengine')) {
  logger.info(config.get('rtpengine'), 'using rtpengine as the recorder');
  callHandler = require('./lib/rtpengine-call-handler');
  const store = require('./lib/metadata-store');
  const registry = require('./lib/call-registry');
  // start DTMF listener
  require('./lib/dtmf-event-handler')(logger);
  // 通话事件 SSE 端点 + 内部管理端点(仅回环,供 siprec-web 代理)
  const events = require('./lib/events');
  events.start(logger, Object.assign({}, config.has('events') ? config.get('events') : {}, {
    control: {
      listCalls: () => registry.entries().map(([key, e]) => ({
        key,
        callId: (e.callDetails && e.callDetails['call-id']) || null,
        caller: (e.caller && e.caller.aor) || null,
        callee: (e.callee && e.callee.aor) || null,
        startedAt: e.startedAt,
        ageSec: Math.round((Date.now() - e.startedAt) / 1000),
      })),
      terminate: (key, reason) => registry.close(key, reason,
        (entry, r) => callHandler.finalizeEntry(entry, r)),
    },
  }));
  // 心跳只刷新真正持有 dialog 的会话(避免幽灵会话被无限续命)
  store.setLiveKeyProvider(() => registry.liveKeys());
  store.startHeartbeat();
  startWatchdog(logger);

  // we only want to deal with siprec invites (having multipart content) in this application
  srf.use('invite', (req, res, next) => {
    const ctype = req.get('Content-Type') || '';
    if (!ctype.includes('multipart/mixed')) {
      logger.info(`rejecting non-SIPREC INVITE with call-id ${req.get('Call-ID')}`);
      events.publish('call_rejected', { callId: req.get('Call-ID'), reason: 'non-siprec' });
      return res.send(488);
    }
    next();
  });

}
else if (config.has('freeswitch')) {
  logger.info(config.get('freeswitch'), 'using freeswitch as the recorder');
  callHandler = require('./lib/freeswitch-call-handler')(logger);
}
else {
  assert('recorder type not specified in configuration: must be either rtpengine or freeswitch');
}

srf.invite(callHandler);

/**
 * 看门狗:每 WATCHDOG_INTERVAL_MS 扫一次在录通话
 *   A. 超长通话(如 8 小时)→ 主动 BYE + 收尾
 *   B. 媒体侧会话已消失(rtpengine 超时删除)→ 快速收尾(默认 2 分钟宽限)
 */
function startWatchdog(logger) {
  const registry = require('./lib/call-registry');
  const MAX = Number(process.env.MAX_CALL_SECONDS || 28800);
  const INTERVAL = Number(process.env.WATCHDOG_INTERVAL_MS || 60000);
  const GRACE = Number(process.env.GONE_GRACE_SECONDS || 120);
  const finalize = (entry, reason) => callHandler.finalizeEntry(entry, reason);

  const timer = setInterval(async () => {
    for (const [key, entry] of registry.entries()) {
      if (entry.closed || entry.closing) continue;
      const ageSec = (Date.now() - entry.startedAt) / 1000;

      if (ageSec > MAX) {
        logger.warn({ key, ageSec: Math.round(ageSec), maxCallSeconds: MAX }, 'watchdog: max duration reached');
        registry.close(key, 'max_duration', finalize);
        continue;
      }
      if (ageSec > GRACE) {
        const alive = await registry.isSessionAlive(entry);
        if (alive === false) {
          logger.warn({ key, ageSec: Math.round(ageSec) }, 'watchdog: rtpengine session gone');
          registry.close(key, 'session_gone', finalize);
        }
      }
    }
  }, INTERVAL);
  timer.unref?.();
  logger.info({ maxCallSeconds: MAX, intervalMs: INTERVAL, graceSeconds: GRACE }, 'call watchdog started');
}

module.exports = srf;

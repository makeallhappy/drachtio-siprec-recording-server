/**
 * call-registry.js —— 在录通话登记表(进程内)
 *
 * 作用:
 *   1. 给看门狗提供"当前所有在录通话"及其 dialog 句柄
 *   2. 给内部 HTTP 控制端点提供"按 session_key 中断通话"的能力
 *   3. 给心跳提供"真正还活着的 key",避免僵尸会话一直被续命
 *
 * key 统一用 active_sessions.session_key(= "<分表名>_<id>"),便于和 DB 对账。
 */
const calls = new Map();

/** 登记一通呼叫 */
function register(key, entry) {
  calls.set(key, {
    key,
    dlg: entry.dlg || null,
    dbRef: entry.dbRef || null,
    callDetails: entry.callDetails || {},
    logger: entry.logger || console,
    rtpEngine: entry.rtpEngine || null,
    caller: entry.caller || null,
    callee: entry.callee || null,
    startedAt: entry.startedAt || Date.now(),
    closed: false,
    closing: false,
    reason: null,
  });
}

function get(key) { return calls.get(key) || null; }
function unregister(key) { calls.delete(key); }
function liveKeys() { return [...calls.keys()]; }
function entries() { return [...calls.entries()]; }
function size() { return calls.size; }

/**
 * 关闭一通呼叫:优先走 dialog.destroy()(UAS 主动发 BYE),
 * 5 秒内没有触发 onCallEnd 则用 finalize 兜底,防止 dialog 已死的场景漏收尾。
 */
function close(key, reason, finalize) {
  const entry = calls.get(key);
  if (!entry || entry.closed || entry.closing) return false;
  entry.closing = true;
  entry.reason = reason;

  try {
    entry.logger.warn({ key, reason, ageSec: Math.round((Date.now() - entry.startedAt) / 1000) },
      'closing call from registry');
    if (entry.dlg && typeof entry.dlg.destroy === 'function') entry.dlg.destroy();
  } catch (err) {
    entry.logger.error(`dlg.destroy failed for ${key}: ${err.message}`);
  }

  setTimeout(() => {
    if (!entry.closed && typeof finalize === 'function') {
      entry.closed = true;
      try { finalize(entry, reason); } catch (err) {
        entry.logger.error(`finalize failed for ${key}: ${err.message}`);
      }
    }
  }, 5000).unref?.();

  return true;
}

/**
 * 媒体侧是否还活着:用 NG query 查 rtpengine。
 * 返回 true=活着 / false=会话已不存在 / null=无法判定(网络错误,按活着处理)
 */
function isSessionAlive(entry) {
  const client = entry.rtpEngine;
  if (!client || !client.query) return Promise.resolve(null);
  const cd = entry.callDetails || {};
  const args = { 'call-id': cd['call-id'], 'from-tag': cd['from-tag'] };
  if (cd['to-tag']) args['to-tag'] = cd['to-tag'];

  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 2000);
    try {
      client.query(client.remote, args)
        .then((res) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (!res) return resolve(null);
          // 不存在的会话:{"result":"error","error-reason":"Unknown call-id"}
          const reason = String(res['error-reason'] || res.error || '');
          if (res.result === 'error' && /unknown\s*call-?id|not\s*found|no\s*such/i.test(reason)) {
            return resolve(false);
          }
          // 存在的会话:返回的是会话详情(created/tags/SSRC...),没有 result=ok 字段
          if (res.tags || res.SSRC || res.created) return resolve(true);
          resolve(null); // 其它错误:无法判定,不误杀
        })
        .catch(() => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(null); // 网络/超时:无法判定,不误杀
        });
    } catch {
      if (!done) { done = true; clearTimeout(timer); resolve(null); }
    }
  });
}

module.exports = { register, get, unregister, liveKeys, entries, size, close, isSessionAlive };

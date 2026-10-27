/**
 * events.js —— 通话事件总线 + SSE 推送端点
 *
 * 为什么在这里做:rtpengine 是请求-响应式的媒体代理,没有通话事件推送能力
 * (它的 /metrics 只能轮询,DTMF 事件是唯一的主动推送且与呼叫生命周期无关)。
 * 而 siprec-server 在任何一通 SIPREC INVITE 建立/结束的那一刻同步就知道全部信息,
 * 因此通话事件应该由它发出。
 *
 * 对外:
 *   GET /events   SSE 流(text/event-stream),连接时先补发最近 20 条
 *   GET /recent   最近事件快照(JSON,便于排查/兜底)
 *   GET /health   {ok:true}
 *
 * 安全:只绑回环,由 siprec-web 带 JWT 代理给前端,不直接对外。
 */
const http = require('http');
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0);

const RING_MAX = 100;
const REPLAY_MAX = 20;
const HEARTBEAT_MS = 15000;

const ring = [];
let seq = 0;

/** 发布一条事件:环形缓冲 + 广播 */
function publish(type, payload = {}) {
  const ev = { id: ++seq, type, ts: Date.now(), ...payload };
  ring.push(ev);
  if (ring.length > RING_MAX) ring.shift();
  bus.emit('event', ev);
  return ev;
}

function recent(n = REPLAY_MAX) {
  return ring.slice(-n);
}

function sseWrite(res, ev) {
  res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
}

function start(logger, opts = {}) {
  const host = opts.host || process.env.EVENTS_HOST || '127.0.0.1';
  const port = Number(opts.port || process.env.EVENTS_PORT || 22224);
  const control = opts.control || null; // { listCalls(), terminate(key, reason) }
  const token = (process.env.INTERNAL_TOKEN || '').trim();

  const authorized = (req) => Boolean(token) && req.headers['x-internal-token'] === token;

  const readJson = (req) => new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 65536) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '').split('?')[0];

    // ---- 内部管理端点(需 X-Internal-Token,只由 siprec-web 调用) ----
    if (url === '/active' || url === '/terminate') {
      if (!authorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
      if (!control) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'control not configured' }));
        return;
      }
      if (url === '/active' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, calls: control.listCalls() }));
        return;
      }
      if (url === '/terminate' && req.method === 'POST') {
        const body = await readJson(req);
        const key = String(body.key || '');
        const reason = String(body.reason || 'admin');
        if (!key) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing key' }));
          return;
        }
        const ok = control.terminate(key, reason);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok, key, reason }));
        return;
      }
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
      return;
    }

    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, subscribers: bus.listenerCount('event') }));
      return;
    }

    if (url === '/recent') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ events: recent() }));
      return;
    }

    if (url !== '/events') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // 断线重连间隔(浏览器 EventSource 会遵守,手写解析时也可参考)
    res.write('retry: 3000\n\n');
    for (const ev of recent()) sseWrite(res, ev);

    const onEvent = (ev) => sseWrite(res, ev);
    bus.on('event', onEvent);
    const hb = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

    const cleanup = () => {
      clearInterval(hb);
      bus.off('event', onEvent);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);

    logger.info(`SSE subscriber attached (total=${bus.listenerCount('event')})`);
  });

  server.on('error', (err) => logger.error(`events server error: ${err.message}`));
  server.listen(port, host, () => logger.info(`call events SSE listening on ${host}:${port}`));

  return server;
}

module.exports = { publish, recent, start, bus };

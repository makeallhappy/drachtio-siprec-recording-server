/**
 * siprec-web —— SIPREC 录音元数据查询服务
 *
 * 从 orekaweb 搬过来的查询功能,数据源换成 siprec 库的 recording_metadata_YYYYMM 分月表。
 * 播放/下载先留空(接口占位 501)。
 * 认证:验证码 + JWT(复用 oreka 库 orkuser/orkloginstring 用户表)
 * HTTPS:复用服务器证书 p12(env 可覆盖)
 *
 * 端口:HTTPS 8443(默认,SSL_ENABLED=true 时);HTTP 8082(SSL_ENABLED=false)
 * 库:DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME(默认 siprec)
 * 用户库:USER_DB_HOST/.../USER_DB_NAME(默认同 DB_HOST 的 oreka 库)
 */
const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const tls = require('tls');
const auth = require('./auth');
const users = require('./users');
const audio = require('./audio');
const createApiV1 = require('./api-v1');
const metrics = require('./metrics');

const app = express();
app.use(express.json());

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'siprec',
  waitForConnections: true,
  connectionLimit: 5,
  timezone: 'Z', // 统一 UTC(DATETIME 无时区,显式约定)
});

// 用户认证库(oreka.orkuser/orkloginstring),默认同 host 的 oreka 库
const userPool = mysql.createPool({
  host: process.env.USER_DB_HOST || process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.USER_DB_PORT || process.env.DB_PORT || 3306),
  user: process.env.USER_DB_USER || process.env.DB_USER || 'root',
  password: process.env.USER_DB_PASSWORD || process.env.DB_PASSWORD || '',
  database: process.env.USER_DB_NAME || 'oreka',
  waitForConnections: true,
  connectionLimit: 3,
  timezone: 'Z',
});

// ==================== 公开路由:验证码 + 登录 ====================
app.get('/api/captcha', (_req, res) => res.json(auth.issueCaptcha()));

app.post('/api/auth/login', async (req, res) => {
  try {
    const { loginString, password, captchaId, captchaCode } = req.body || {};
    if (!auth.verifyCaptcha(captchaId, captchaCode)) {
      return res.status(401).json({ error: '验证码错误或已过期' });
    }
    const user = await auth.authenticate(userPool, loginString, password);
    if (!user) {
      return res.status(401).json({ error: '登录名或密码错误' });
    }
    const token = auth.signToken(user, loginString);
    res.json({ accessToken: token, tokenType: 'Bearer', user });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

/** 当前登录用户 */
app.get('/api/auth/me', auth.requireAuth, (req, res) => res.json({ user: req.user }));

// ==================== 用户管理(JWT 保护,oreka 库) ====================
app.get('/api/users', auth.requireAuth, async (req, res) => {
  try {
    res.json(await users.list(userPool, req.query.includeDeleted === 'true'));
  } catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});

app.get('/api/users/:id', auth.requireAuth, async (req, res) => {
  try {
    const u = await users.getById(userPool, Number(req.params.id));
    if (!u) return res.status(404).json({ error: 'not found' });
    u.loginStrings = await users.getLoginStrings(userPool, u.id);
    res.json(u);
  } catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});

app.post('/api/users', auth.requireAuth, async (req, res) => {
  try {
    const u = await users.create(userPool, req.body || {});
    res.status(201).json(u);
  } catch (err) { res.status(400).json({ error: String(err.message || err) }); }
});

app.put('/api/users/:id', auth.requireAuth, async (req, res) => {
  try {
    const u = await users.update(userPool, Number(req.params.id), req.body || {});
    if (!u) return res.status(404).json({ error: 'not found' });
    res.json(u);
  } catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});

app.delete('/api/users/:id', auth.requireAuth, async (req, res) => {
  try {
    const ok = await users.remove(userPool, Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  } catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});

// ==================== 业务接口(JWT 保护) ====================

/** 现有分月表清单(recording_metadata_YYYYMM) */
async function listTables() {
  const [rows] = await pool.query(
    `SELECT table_name AS t FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name LIKE 'recording\\_metadata\\_______'
      ORDER BY table_name DESC`
  );
  return rows.map((r) => r.t);
}

/**
 * 跨月 UNION 查询
 * 参数:page,size, caller, callee, startTime, endTime (ms epoch), minDuration,maxDuration(ms)
 */
app.get('/api/recordings', auth.requireAuth, async (req, res) => {
  try {
    const page = Math.max(0, Number(req.query.page || 0));
    const size = Math.min(200, Math.max(1, Number(req.query.size || 20)));
    const caller = (req.query.caller || '').trim();
    const callee = (req.query.callee || '').trim();
    const startTime = req.query.startTime ? new Date(Number(req.query.startTime)) : null;
    const endTime = req.query.endTime ? new Date(Number(req.query.endTime)) : null;
    const minDur = req.query.minDuration ? Number(req.query.minDuration) : null;
    const maxDur = req.query.maxDuration ? Number(req.query.maxDuration) : null;

    const tables = await listTables();
    if (tables.length === 0) return res.json({ total: 0, content: [] });

    const conds = [];
    const params = [];
    if (caller) { conds.push('(caller_number LIKE ? OR caller_aor LIKE ? OR caller_name LIKE ?)'); params.push(`%${caller}%`, `%${caller}%`, `%${caller}%`); }
    if (callee) { conds.push('(callee_number LIKE ? OR callee_aor LIKE ? OR callee_name LIKE ?)'); params.push(`%${callee}%`, `%${callee}%`, `%${callee}%`); }
    if (startTime) { conds.push('start_time >= ?'); params.push(startTime); }
    if (endTime) { conds.push('start_time <= ?'); params.push(endTime); }
    if (minDur != null) { conds.push('duration_ms >= ?'); params.push(minDur); }
    if (maxDur != null) { conds.push('duration_ms <= ?'); params.push(maxDur); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const cols = 'id, session_id, recording_session_id, original_call_id, caller_aor, caller_name, caller_number, callee_aor, callee_name, callee_number, start_time, end_time, duration_ms, created_at';
    const unionSql = tables.map((t) => `SELECT ${cols}, '${t}' AS src_table FROM \`${t}\` ${where}`).join(' UNION ALL ');

    const [cntRows] = await pool.query(`SELECT COUNT(*) AS total FROM (${unionSql}) u`, params);
    const total = cntRows[0].total;

    const pageSql = `${unionSql} ORDER BY start_time DESC LIMIT ? OFFSET ?`;
    const [rows] = await pool.query(pageSql, [...params, size, page * size]);

    res.json({ total, page, size, content: rows });
  } catch (err) {
    console.error('query error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

/** 详情(含 sdp/metadata_xml) */
app.get('/api/recordings/:table/:id', auth.requireAuth, async (req, res) => {
  try {
    const table = req.params.table;
    if (!/^recording_metadata_\d{6}$/.test(table)) return res.status(400).json({ error: 'bad table' });
    const [rows] = await pool.query(`SELECT * FROM \`${table}\` WHERE id = ?`, [Number(req.params.id)]);
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

/** 分月表清单 */
app.get('/api/tables', auth.requireAuth, async (_req, res) => {
  try { res.json(await listTables()); }
  catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});

/** 播放/下载 —— 按 original_call_id 找 pcap → 转 wav/mp3 → 带 Range 流式返回 */
async function getCallId(table, id) {
  if (!/^recording_metadata_\d{6}$/.test(table)) return null;
  const [rows] = await pool.query(`SELECT original_call_id FROM \`${table}\` WHERE id = ?`, [id]);
  return rows.length ? rows[0].original_call_id : null;
}
app.get('/api/recordings/:table/:id/audio', auth.requireAuth, audio.audioHandler(getCallId));
app.get('/api/recordings/:table/:id/download', auth.requireAuth, (req, res, next) => {
  req.query.download = '1';
  audio.audioHandler(getCallId)(req, res, next);
});

// ==================== 看板:系统实时指标(WEB 页面用,JWT 保护) ====================
app.get('/api/system/metrics', auth.requireAuth, async (_req, res) => {
  try {
    const [cpu, mem, disk] = await Promise.all([
      metrics.cpuUsage(),
      Promise.resolve(metrics.memoryUsage()),
      metrics.diskUsage(process.env.RECORDING_ROOT || (fs.existsSync('/recordings') ? '/recordings' : path.join(__dirname, '..', 'recordings'))),
    ]);
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS active FROM active_sessions
        WHERE last_heartbeat >= NOW(3) - INTERVAL 30 SECOND`);
    res.json({
      ts: Date.now(),
      activeRecordings: rows[0].active,
      cpu: { usagePercent: cpu, cores: metrics.cpuCount(), ...metrics.loadAvg() },
      memory: mem,
      disk,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ==================== 对外 API v1(静态 Token,第三方对接) ====================
app.use('/api/v1', createApiV1({ pool, listTables, getCallId }));

/** 健康检查(公开,供探活) */
app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: String(err.message || err) }); }
});

/** 静态托管前端构建产物(Vue3,若存在) */
const dist = path.join(__dirname, 'public');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  // SPA history 路由兜底(Express 5 用正则,不再支持 '*')
  app.get(/.*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// ==================== 启动:HTTPS(默认) 或 HTTP ====================
const SSL_ENABLED = (process.env.SSL_ENABLED || 'true') === 'true';
const P12_PATH = process.env.SSL_P12_PATH || '/certs/ork.p12';
const P12_PASS = process.env.SSL_P12_PASSWORD || '';
const HTTPS_PORT = Number(process.env.WEB_HTTPS_PORT || 8444);
const HTTP_PORT = Number(process.env.WEB_PORT || 8082);

if (SSL_ENABLED) {
  try {
    const pfx = fs.readFileSync(P12_PATH);
    const server = https.createServer({ pfx, passphrase: P12_PASS, secureOptions: tls.DEFAULT_MIN_VERSION ? undefined : 0 }, app);
    server.listen(HTTPS_PORT, () => console.log(`siprec-web HTTPS listening on :${HTTPS_PORT}, db=${process.env.DB_NAME || 'siprec'}, cert=${P12_PATH}`));
  } catch (err) {
    console.error(`HTTPS 启动失败(${P12_PATH}): ${err.message} —— 回退 HTTP :${HTTP_PORT}`);
    http.createServer(app).listen(HTTP_PORT, () => console.log(`siprec-web HTTP listening on :${HTTP_PORT} (HTTPS 回退)`));
  }
} else {
  http.createServer(app).listen(HTTP_PORT, () => console.log(`siprec-web HTTP listening on :${HTTP_PORT}, db=${process.env.DB_NAME || 'siprec'}`));
}

/**
 * siprec-web —— SIPREC 录音元数据查询服务
 *
 * 从 orekaweb 搬过来的查询功能,数据源换成 siprec 库的 recording_metadata_YYYYMM 分月表。
 * 播放/下载先留空(接口占位 501)。
 *
 * 端口:WEB_PORT(默认 8082)
 * 库:DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME(默认 siprec)
 */
const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

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
});

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
app.get('/api/recordings', async (req, res) => {
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

    // 每张表构造一段 SELECT,WHERE 条件用命名参数拼接
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

    // total
    const [cntRows] = await pool.query(`SELECT COUNT(*) AS total FROM (${unionSql}) u`, params);
    const total = cntRows[0].total;

    // page
    const pageSql = `${unionSql} ORDER BY start_time DESC LIMIT ? OFFSET ?`;
    const [rows] = await pool.query(pageSql, [...params, size, page * size]);

    res.json({ total, page, size, content: rows });
  } catch (err) {
    console.error('query error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

/** 详情(含 sdp/metadata_xml) */
app.get('/api/recordings/:table/:id', async (req, res) => {
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

/** 分月表清单(前端时间范围/排查用) */
app.get('/api/tables', async (_req, res) => {
  try { res.json(await listTables()); }
  catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});

/** 播放/下载 —— 先留空(占位 501) */
app.get('/api/recordings/:table/:id/audio', (_req, res) => res.status(501).json({ error: 'audio playback not implemented yet' }));
app.get('/api/recordings/:table/:id/download', (_req, res) => res.status(501).json({ error: 'download not implemented yet' }));

/** 健康检查 */
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

const port = Number(process.env.WEB_PORT || 8082);
app.listen(port, () => console.log(`siprec-web listening on :${port}, db=${process.env.DB_NAME || 'siprec'}`));

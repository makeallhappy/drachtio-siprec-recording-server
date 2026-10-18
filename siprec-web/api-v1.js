/**
 * api-v1.js —— 对外查询/播放 RESTful 接口(第三方对接用)
 *
 * 鉴权:静态 Token(配置文件 / 环境变量),不走 JWT/验证码。
 *   Header: Authorization: Bearer <API_TOKEN>
 *   API_TOKEN 从 env(API_TOKEN) 或 config/ 读取,见下方。
 *
 * 设计:
 *   - 统一响应格式 { code, message, data }
 *   - 对外用 recordingId(= "<表名>_<id>")隐藏分表细节
 *   - 音频流支持 Range(拖动/断点续传)
 *   - 复用现有 pool(listTables/getCallId) 与 audio.audioHandler
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const audio = require('./audio');

/**
 * 静态鉴权 Token 解析顺序:
 *   1. 环境变量 API_TOKEN
 *   2. 配置文件 api-config.json(容器 /app/api-config.json,本地 siprec-web/api-config.json)
 *   3. 都没有 -> 接口 500(强制配置,避免裸奔)
 */
function loadApiToken() {
  if (process.env.API_TOKEN) return process.env.API_TOKEN.trim();
  const candidates = [
    path.join(__dirname, 'api-config.json'),
    path.join(__dirname, '..', 'api-config.json'),
  ];
  for (const p of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (cfg.apiToken) return String(cfg.apiToken).trim();
    } catch { /* 不存在或格式错,继续找 */ }
  }
  return '';
}

const API_TOKEN = loadApiToken();

/** Bearer token 鉴权中间件 */
function requireToken(req, res, next) {
  if (!API_TOKEN) {
    return res.status(500).json({ code: 50000, message: 'server: API_TOKEN 未配置' });
  }
  const auth = req.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== API_TOKEN) {
    return res.status(401).json({ code: 40100, message: 'unauthorized: invalid or missing token' });
  }
  next();
}

const ok = (res, data) => res.json({ code: 0, message: 'ok', data });
const fail = (res, status, code, message) => res.status(status).json({ code, message, data: null });

/**
 * 创建 /api/v1 路由
 * @param {object} deps { pool, listTables, getCallId }
 */
function createApiV1(deps) {
  const { pool, listTables, getCallId } = deps;
  const r = express.Router();

  // 全部需要 token(除健康检查外)
  r.use('/recordings', requireToken);

  // 统一错误包装
  const wrap = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('api-v1 error:', err);
      fail(res, 500, 50000, String(err.message || err));
    });
  };

  // ---------- 查询列表 ----------
  // GET /api/v1/recordings?caller=&callee=&startTime=&endTime=&minDuration=&maxDuration=&page=&size=&sort=&order=
  r.get('/recordings', wrap(async (req, res) => {
    const page = Math.max(1, Number(req.query.page || 1));
    const size = Math.min(200, Math.max(1, Number(req.query.size || 20)));
    const caller = (req.query.caller || '').trim();
    const callee = (req.query.callee || '').trim();
    const startTime = req.query.startTime ? new Date(Number(req.query.startTime)) : null;
    const endTime = req.query.endTime ? new Date(Number(req.query.endTime)) : null;
    const minDur = req.query.minDuration ? Number(req.query.minDuration) : null;
    const maxDur = req.query.maxDuration ? Number(req.query.maxDuration) : null;
    const sort = (req.query.sort || 'start_time').replace(/[^a-z_]/gi, '');
    const order = (req.query.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const tables = await listTables();
    if (tables.length === 0) return ok(res, { total: 0, page, size, items: [] });

    const conds = [];
    const params = [];
    if (caller) { conds.push('(caller_number LIKE ? OR caller_aor LIKE ? OR caller_name LIKE ?)'); params.push(`%${caller}%`, `%${caller}%`, `%${caller}%`); }
    if (callee) { conds.push('(callee_number LIKE ? OR callee_aor LIKE ? OR callee_name LIKE ?)'); params.push(`%${callee}%`, `%${callee}%`, `%${callee}%`); }
    if (startTime) { conds.push('start_time >= ?'); params.push(startTime); }
    if (endTime) { conds.push('start_time <= ?'); params.push(endTime); }
    if (minDur != null) { conds.push('duration_ms >= ?'); params.push(minDur); }
    if (maxDur != null) { conds.push('duration_ms <= ?'); params.push(maxDur); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const cols = 'id, recording_session_id, original_call_id, caller_number, caller_name, callee_number, callee_name, start_time, end_time, duration_ms';
    const unionSql = tables.map((t) => `SELECT ${cols}, '${t}' AS src_table FROM \`${t}\` ${where}`).join(' UNION ALL ');

    const [cntRows] = await pool.query(`SELECT COUNT(*) AS total FROM (${unionSql}) u`, params);
    const total = cntRows[0].total;

    const pageSql = `${unionSql} ORDER BY ${sort} ${order} LIMIT ? OFFSET ?`;
    const [rows] = await pool.query(pageSql, [...params, size, (page - 1) * size]);

    const items = rows.map((r) => ({
      recordingId: `${String(r.src_table).replace('recording_metadata_', '')}_${r.id}`,
      callerNumber: r.caller_number,
      callerName: r.caller_name,
      calleeNumber: r.callee_number,
      calleeName: r.callee_name,
      startTime: r.start_time,
      endTime: r.end_time,
      durationMs: r.duration_ms,
      recordingSessionId: r.recording_session_id,
      originalCallId: r.original_call_id,
    }));

    ok(res, { total, page, size, items });
  }));

  // ---------- 单条详情 ----------
  // GET /api/v1/recordings/:recordingId   (recordingId = "202610_25")
  r.get('/recordings/:recordingId', wrap(async (req, res) => {
    const { table, id } = splitRecordingId(req.params.recordingId);
    if (!table || !id) return fail(res, 400, 40001, 'invalid recordingId, expect <table>_<id> e.g. 202610_25');
    if (!/^recording_metadata_\d{6}$/.test(table)) return fail(res, 400, 40001, 'invalid table');
    const [rows] = await pool.query(`SELECT * FROM \`${table}\` WHERE id = ?`, [id]);
    if (rows.length === 0) return fail(res, 404, 40401, 'recording not found');
    const r = rows[0];
    ok(res, {
      recordingId: `${table.replace('recording_metadata_', '')}_${r.id}`,
      callerNumber: r.caller_number, callerName: r.caller_name, callerAor: r.caller_aor,
      calleeNumber: r.callee_number, calleeName: r.callee_name, calleeAor: r.callee_aor,
      startTime: r.start_time, endTime: r.end_time, durationMs: r.duration_ms,
      recordingSessionId: r.recording_session_id, originalCallId: r.original_call_id,
      sdp: r.sdp_offer, metadataXml: r.metadata_xml,
    });
  }));

  // ---------- 音频流 ----------
  // GET /api/v1/recordings/:recordingId/audio?fmt=wav|mp3|flac   (支持 Range)
  r.get('/recordings/:recordingId/audio', wrap(async (req, res) => {
    const { table, id } = splitRecordingId(req.params.recordingId);
    if (!table || !id) return fail(res, 400, 40001, 'invalid recordingId');
    // 复用内部 audioHandler,但它返回的是 /api/recordings/:table/:id 路径
    // 这里手动调 getCallId + audio 服务,保持 v1 统一响应不便直接复用 handler 的 res
    const callid = await getCallId(table, id);
    if (!callid) return fail(res, 404, 40401, 'recording not found (no call-id)');

    // 复用 audio 内部逻辑:定位 pcap / 归档 flac → 转目标格式 → 流式返回
    await audio.streamForCallId(callid, req.query.fmt || 'wav', req, res, {
      onNotFound: () => fail(res, 404, 40401, 'no audio file for recording'),
    });
  }));

  // ---------- 下载(attachment) ----------
  // GET /api/v1/recordings/:recordingId/download?fmt=wav|mp3|flac
  r.get('/recordings/:recordingId/download', wrap(async (req, res) => {
    const { table, id } = splitRecordingId(req.params.recordingId);
    if (!table || !id) return fail(res, 400, 40001, 'invalid recordingId');
    const callid = await getCallId(table, id);
    if (!callid) return fail(res, 404, 40401, 'recording not found (no call-id)');
    await audio.streamForCallId(callid, req.query.fmt || 'wav', req, res, {
      download: true,
      onNotFound: () => fail(res, 404, 40401, 'no audio file for recording'),
    });
  }));

  // ---------- 健康检查(公开,不需要 token) ----------
  r.get('/health', async (_req, res) => {
    try { await pool.query('SELECT 1'); ok(res, { status: 'up' }); }
    catch (err) { fail(res, 500, 50000, String(err.message || err)); }
  });

  return r;
}

/** "202610_25" -> { table: "recording_metadata_202610", id: 25 } */
function splitRecordingId(recordingId) {
  if (!recordingId || typeof recordingId !== 'string') return {};
  const i = recordingId.lastIndexOf('_');
  if (i < 0) return {};
  const yymm = recordingId.slice(0, i);
  const id = Number(recordingId.slice(i + 1));
  if (!/^\d{6}$/.test(yymm) || !Number.isInteger(id) || id <= 0) return {};
  return { table: `recording_metadata_${yymm}`, id };
}

module.exports = createApiV1;

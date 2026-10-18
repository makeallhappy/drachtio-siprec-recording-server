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

/** 录音根目录(容器 /recordings;宿主机开发为 ../recordings) */
const REC_ROOT = process.env.RECORDING_ROOT ||
  (fs.existsSync('/recordings') ? '/recordings' : path.join(__dirname, '..', 'recordings'));

/** 递归统计目录大小与文件数 */
async function dirStats(dir) {
  let bytes = 0;
  let files = 0;
  async function walk(d) {
    let entries;
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        try { const st = await fs.promises.stat(p); bytes += st.size; files++; } catch { /* ignore */ }
      }
    }
  }
  await walk(dir);
  return { bytes, files };
}

const ok = (res, data) => res.json({ code: 0, message: 'ok', data });
const fail = (res, status, code, message) => res.status(status).json({ code, message, data: null });

/** 布尔全文检索词转义:双引号包裹做短语匹配(ngram 下等价子串匹配) */
function boolPhrase(s) {
  return '"' + String(s).replace(/["\\]/g, ' ').trim() + '"';
}

/**
 * 创建 /api/v1 路由
 * @param {object} deps { pool, listTables, getCallId }
 */
function createApiV1(deps) {
  const { pool, listTables, getCallId } = deps;
  const r = express.Router();

  // 全部需要 token(除健康检查外)
  r.use(['/recordings', '/stats'], requireToken);

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
    // 混合检索:ngram 全文索引(走索引) + LIKE 兜底(保证短串/符号场景正确)
    if (caller) {
      conds.push(`(MATCH(caller_number, caller_name, caller_aor) AGAINST (? IN BOOLEAN MODE)
                   OR caller_number LIKE ? OR caller_aor LIKE ? OR caller_name LIKE ?)`);
      params.push(boolPhrase(caller), `%${caller}%`, `%${caller}%`, `%${caller}%`);
    }
    if (callee) {
      conds.push(`(MATCH(callee_number, callee_name, callee_aor) AGAINST (? IN BOOLEAN MODE)
                   OR callee_number LIKE ? OR callee_aor LIKE ? OR callee_name LIKE ?)`);
      params.push(boolPhrase(callee), `%${callee}%`, `%${callee}%`, `%${callee}%`);
    }
    const tag = (req.query.tag || '').trim();
    if (tag) { conds.push('thirdpty_append = ?'); params.push(tag); }
    if (startTime) { conds.push('start_time >= ?'); params.push(startTime); }
    if (endTime) { conds.push('start_time <= ?'); params.push(endTime); }
    if (minDur != null) { conds.push('duration_ms >= ?'); params.push(minDur); }
    if (maxDur != null) { conds.push('duration_ms <= ?'); params.push(maxDur); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const cols = 'id, recording_session_id, original_call_id, caller_number, caller_name, callee_number, callee_name, start_time, end_time, duration_ms, thirdpty_append, archived, audio_size_bytes';
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
      thirdPartyTag: r.thirdpty_append,
      archived: !!r.archived,
      audioSizeBytes: r.audio_size_bytes,
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
      thirdPartyTag: r.thirdpty_append,
      leftChannelText: r.left_channel_txt,
      rightChannelText: r.right_channel_txt,
      archived: !!r.archived,
      audioSizeBytes: r.audio_size_bytes,
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

  // ---------- 第三方标签 ----------
  // PUT /api/v1/recordings/:recordingId/tag   body: { "tag": "crm-12345" }
  r.put('/recordings/:recordingId/tag', wrap(async (req, res) => {
    const { table, id } = splitRecordingId(req.params.recordingId);
    if (!table || !id) return fail(res, 400, 40001, 'invalid recordingId');
    const tag = req.body && req.body.tag != null ? String(req.body.tag).slice(0, 255) : null;
    if (tag === null) return fail(res, 400, 40002, 'missing field: tag');
    const [r2] = await pool.query(`UPDATE \`${table}\` SET thirdpty_append = ? WHERE id = ?`, [tag, id]);
    if (r2.affectedRows === 0) return fail(res, 404, 40401, 'recording not found');
    ok(res, { recordingId: `${table.replace('recording_metadata_', '')}_${id}`, thirdPartyTag: tag });
  }));

  // ---------- 声道转写文本 ----------
  // PUT /api/v1/recordings/:recordingId/transcript
  // body: { "left": "主叫文本", "right": "被叫文本" }(可只传其一)
  r.put('/recordings/:recordingId/transcript', wrap(async (req, res) => {
    const { table, id } = splitRecordingId(req.params.recordingId);
    if (!table || !id) return fail(res, 400, 40001, 'invalid recordingId');
    const b = req.body || {};
    if (b.left == null && b.right == null) {
      return fail(res, 400, 40002, 'missing field: left and/or right');
    }
    const sets = [];
    const params = [];
    if (b.left != null) { sets.push('left_channel_txt = ?'); params.push(String(b.left)); }
    if (b.right != null) { sets.push('right_channel_txt = ?'); params.push(String(b.right)); }
    params.push(id);
    const [r2] = await pool.query(`UPDATE \`${table}\` SET ${sets.join(', ')} WHERE id = ?`, params);
    if (r2.affectedRows === 0) return fail(res, 404, 40401, 'recording not found');
    ok(res, { recordingId: `${table.replace('recording_metadata_', '')}_${id}`, updated: sets.length });
  }));

  // ---------- 实时统计:正在录音数 ----------
  // GET /api/v1/stats/active?detail=1
  // 依据 active_sessions 心跳表:last_heartbeat 在 30 秒内视为在录
  // (容忍 3 次 10 秒心跳丢失;实例崩溃留下的行会被心跳超时过滤)
  r.get('/stats/active', wrap(async (req, res) => {
    const [cnt] = await pool.query(
      `SELECT COUNT(*) AS active FROM active_sessions
        WHERE last_heartbeat >= NOW(3) - INTERVAL 30 SECOND`);
    const data = {
      activeRecordings: cnt[0].active,
      heartbeatIntervalSec: 10,
      activeWindowSec: 30,
      checkedAt: new Date().toISOString(),
    };
    if (req.query.detail === '1') {
      const [rows] = await pool.query(
        `SELECT session_key, call_id, recording_session_id, caller_number, callee_number,
                start_time, last_heartbeat, TIMESTAMPDIFF(SECOND, start_time, NOW(3)) AS elapsed_sec
           FROM active_sessions
          WHERE last_heartbeat >= NOW(3) - INTERVAL 30 SECOND
          ORDER BY start_time DESC`);
      data.sessions = rows.map((x) => ({
        sessionKey: x.session_key,
        callId: x.call_id,
        recordingSessionId: x.recording_session_id,
        callerNumber: x.caller_number,
        calleeNumber: x.callee_number,
        startTime: x.start_time,
        lastHeartbeat: x.last_heartbeat,
        elapsedSec: x.elapsed_sec,
      }));
    }
    ok(res, data);
  }));

  // ---------- 存储统计 ----------
  // GET /api/v1/stats/storage
  // 返回各录音目录占用 + 底层文件系统容量(宿主机磁盘) + 低空间标记
  r.get('/stats/storage', wrap(async (_req, res) => {
    const dirs = {
      pcap: path.join(REC_ROOT, 'pcaps'),
      flac: path.join(REC_ROOT, 'flac'),
      cache: path.join(REC_ROOT, 'cache'),
      tmp: path.join(REC_ROOT, 'tmp'),
    };
    const [pcap, flac, cache, tmp] = await Promise.all([
      dirStats(dirs.pcap), dirStats(dirs.flac), dirStats(dirs.cache), dirStats(dirs.tmp),
    ]);

    const disk = { totalBytes: null, freeBytes: null, usedPercent: null };
    try {
      const st = await fs.promises.statfs(REC_ROOT);
      const total = Number(st.blocks) * Number(st.bsize);
      const free = Number(st.bavail) * Number(st.bsize);
      if (total > 0) {
        disk.totalBytes = total;
        disk.freeBytes = free;
        disk.usedPercent = Math.round((1 - free / total) * 1000) / 10;
      }
    } catch { /* statfs 不可用时保持 null */ }

    const lowSpace = disk.freeBytes != null && disk.totalBytes
      ? (disk.freeBytes / disk.totalBytes) < 0.10
      : null;

    ok(res, {
      pcapBytes: pcap.bytes, pcapFiles: pcap.files,
      flacBytes: flac.bytes, flacFiles: flac.files,
      cacheBytes: cache.bytes, cacheFiles: cache.files,
      tmpBytes: tmp.bytes, tmpFiles: tmp.files,
      totalRecordingBytes: pcap.bytes + flac.bytes + cache.bytes + tmp.bytes,
      disk: {
        totalBytes: disk.totalBytes,
        freeBytes: disk.freeBytes,
        usedPercent: disk.usedPercent,
        lowSpace,               // 可用空间 < 10% 时为 true
        lowSpaceThresholdPercent: 10,
      },
      recordingRoot: REC_ROOT,
      checkedAt: new Date().toISOString(),
    });
  }));

  // ---------- 汇总统计 ----------
  // GET /api/v1/stats/summary?from=<ms>&to=<ms>
  r.get('/stats/summary', wrap(async (req, res) => {
    const from = req.query.from ? new Date(Number(req.query.from)) : null;
    const to = req.query.to ? new Date(Number(req.query.to)) : null;
    const tables = await listTables();
    if (tables.length === 0) {
      return ok(res, { total: 0, completed: 0, inProgress: 0, totalDurationMs: 0, avgDurationMs: 0 });
    }
    const conds = [];
    const params = [];
    if (from) { conds.push('start_time >= ?'); params.push(from); }
    if (to) { conds.push('start_time <= ?'); params.push(to); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    let total = 0, completed = 0, inProgress = 0, totalDurationMs = 0;
    for (const t of tables) {
      const [rows] = await pool.query(
        `SELECT COUNT(*) AS n,
                SUM(end_time IS NOT NULL) AS done,
                SUM(end_time IS NULL) AS running,
                COALESCE(SUM(duration_ms), 0) AS dur
           FROM \`${t}\` ${where}`, params);
      total += Number(rows[0].n || 0);
      completed += Number(rows[0].done || 0);
      inProgress += Number(rows[0].running || 0);
      totalDurationMs += Number(rows[0].dur || 0);
    }
    ok(res, {
      total, completed, inProgress, totalDurationMs,
      avgDurationMs: completed > 0 ? Math.round(totalDurationMs / completed) : 0,
      from: from ? from.toISOString() : null,
      to: to ? to.toISOString() : null,
      tables: tables.length,
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

/**
 * SIPREC 录音元数据持久化(MySQL,分月分表)
 *
 * - 库:siprec(独立,不污染 oreka)
 * - 分表:recording_metadata_YYYYMM,每月一张,首次写入时自动创建
 * - 生命周期:
 *     onCallStart()  -> INVITE 时 INSERT 一条(end_time/duration 为 NULL)
 *     onCallEnd()    -> BYE/destroy 时 UPDATE end_time + duration
 *
 * 配置(config 或环境变量):
 *   db.host/db.port/db.user/db.password/db.database
 *   或 DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME
 */
const mysql = require('mysql2/promise');
const config = require('config');

let pool = null;

function getPool() {
  if (pool) return pool;
  const host = process.env.DB_HOST || (config.has('db.host') ? config.get('db.host') : 'localhost');
  const port = process.env.DB_PORT || (config.has('db.port') ? config.get('db.port') : 3306);
  const user = process.env.DB_USER || (config.has('db.user') ? config.get('db.user') : 'root');
  const password = process.env.DB_PASSWORD || (config.has('db.password') ? config.get('db.password') : '');
  const database = process.env.DB_NAME || (config.has('db.database') ? config.get('db.database') : 'siprec');
  pool = mysql.createPool({
    host, port, user, password, database,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    // 连接串不指定默认库也可,但这里指定;分表名动态拼
  });
  return pool;
}

/** 当前月分表名,如 recording_metadata_202610 */
function tableFor(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `recording_metadata_${y}${m}`;
}

/** 建分表(IF NOT EXISTS,幂等) */
async function ensureTable(conn, table) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS \`${table}\` (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      session_id VARCHAR(128) DEFAULT NULL COMMENT '本地 UUID',
      recording_session_id VARCHAR(255) DEFAULT NULL COMMENT 'SIPREC session_id',
      original_call_id VARCHAR(255) DEFAULT NULL COMMENT '原始 Call-ID(有 callData 时)',
      caller_aor VARCHAR(255) DEFAULT NULL,
      caller_name VARCHAR(255) DEFAULT NULL,
      caller_number VARCHAR(64) DEFAULT NULL,
      callee_aor VARCHAR(255) DEFAULT NULL,
      callee_name VARCHAR(255) DEFAULT NULL,
      callee_number VARCHAR(64) DEFAULT NULL,
      start_time DATETIME(3) NOT NULL,
      end_time DATETIME(3) DEFAULT NULL,
      duration_ms INT UNSIGNED DEFAULT NULL COMMENT '通话时长(毫秒),结束时回填',
      sdp_offer MEDIUMTEXT DEFAULT NULL,
      metadata_xml MEDIUMTEXT DEFAULT NULL COMMENT 'SIPREC rs-metadata 原始 XML',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_start_time (start_time),
      KEY idx_recording_session_id (recording_session_id),
      KEY idx_caller_number (caller_number),
      KEY idx_callee_number (callee_number)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

/**
 * INVITE 建立时插入一条记录。
 * @param {object} opts payload-parser 解析后的 opts
 * @returns {Promise<{table:string,id:number}>}
 */
async function onCallStart(opts) {
  const table = tableFor();
  const conn = await getPool().getConnection();
  try {
    await ensureTable(conn, table);
    const caller = opts.caller || {};
    const callee = opts.callee || {};
    const [res] = await conn.query(
      `INSERT INTO \`${table}\`
        (session_id, recording_session_id, original_call_id,
         caller_aor, caller_name, caller_number,
         callee_aor, callee_name, callee_number,
         start_time, sdp_offer, metadata_xml)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        opts.sessionId || null,
        opts.recordingSessionId || null,
        opts.originalCallId || null,
        caller.aor || null, caller.name || null, caller.number || null,
        callee.aor || null, callee.name || null, callee.number || null,
        new Date(opts.startTime || Date.now()),
        opts.sdp1 ? `${opts.sdp1}${opts.sdp2 || ''}` : (opts.sdp || null),
        opts.xml || null,
      ]
    );
    return { table, id: res.insertId };
  } finally {
    conn.release();
  }
}

/**
 * BYE/destroy 时回填结束时间与时长。
 * @param {object} ref onCallStart 返回的 {table,id}
 * @param {number} endTime 结束时刻(ms)
 */
async function onCallEnd(ref, endTime = Date.now()) {
  if (!ref || !ref.id) return;
  const conn = await getPool().getConnection();
  try {
    await conn.query(
      `UPDATE \`${ref.table}\`
         SET end_time = ?, duration_ms = TIMESTAMPDIFF(MICROSECOND, start_time, ?) / 1000
       WHERE id = ?`,
      [new Date(endTime), new Date(endTime), ref.id]
    );
  } finally {
    conn.release();
  }
}

// ==================== 活跃会话表 + 心跳(生产级实时统计) ====================
/**
 * 设计:
 *   - 表 active_sessions 记录当前正在录音的会话(一行一个 SIPREC 会话)
 *   - 每个 siprec-server 实例每 10 秒对本实例在录会话刷 last_heartbeat
 *   - 统计"正在录音数"时只认 last_heartbeat >= NOW() - 30 秒(容忍 3 次心跳丢失)
 *   - 呼叫结束立即 DELETE;实例崩溃留下的僵尸行由心跳超时过滤并定期清理
 */
const HEARTBEAT_MS = 10 * 1000;      // 心跳间隔
const ACTIVE_TTL_SEC = 30;           // 活跃判定窗口(3 次心跳)
const activeKeys = new Set();        // 本实例在录会话 key(<table>_<id>)
let heartbeatTimer = null;
let nodeId = null;

function getNodeId() {
  if (!nodeId) nodeId = `${require('os').hostname()}:${process.pid}`;
  return nodeId;
}

async function ensureActiveTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS active_sessions (
      session_key VARCHAR(128) NOT NULL PRIMARY KEY,
      call_id VARCHAR(255) DEFAULT NULL,
      recording_session_id VARCHAR(255) DEFAULT NULL,
      caller_number VARCHAR(64) DEFAULT NULL,
      callee_number VARCHAR(64) DEFAULT NULL,
      start_time DATETIME(3) NOT NULL,
      last_heartbeat DATETIME(3) NOT NULL,
      node_id VARCHAR(128) DEFAULT NULL,
      KEY idx_last_heartbeat (last_heartbeat)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

/** 呼叫开始:登记活跃会话 */
async function startActiveSession(opts, ref) {
  if (!ref || !ref.id) return;
  const key = `${ref.table}_${ref.id}`;
  const caller = opts.caller || {};
  const callee = opts.callee || {};
  const conn = await getPool().getConnection();
  try {
    await ensureActiveTable(conn);
    await conn.query(
      `INSERT INTO active_sessions
         (session_key, call_id, recording_session_id, caller_number, callee_number,
          start_time, last_heartbeat, node_id)
       VALUES (?,?,?,?,?,?,NOW(3),?)
       ON DUPLICATE KEY UPDATE last_heartbeat = NOW(3)`,
      [key, opts.originalCallId || opts.callId || null, opts.recordingSessionId || null,
       caller.number || null, callee.number || null,
       new Date(opts.startTime || Date.now()), getNodeId()]
    );
    activeKeys.add(key);
  } finally {
    conn.release();
  }
}

/** 呼叫结束:移除活跃会话 */
async function endActiveSession(ref) {
  if (!ref || !ref.id) return;
  const key = `${ref.table}_${ref.id}`;
  activeKeys.delete(key);
  const conn = await getPool().getConnection();
  try {
    await conn.query('DELETE FROM active_sessions WHERE session_key = ?', [key]);
  } finally {
    conn.release();
  }
}

/** 心跳:刷新本实例在录会话 + 清理超时僵尸行 */
async function heartbeatOnce() {
  const conn = await getPool().getConnection();
  try {
    await ensureActiveTable(conn);
    if (activeKeys.size > 0) {
      const keys = [...activeKeys];
      const placeholders = keys.map(() => '?').join(',');
      await conn.query(
        `UPDATE active_sessions SET last_heartbeat = NOW(3)
          WHERE session_key IN (${placeholders})`, keys);
    }
    // 清理长时间无心跳的僵尸行(其他实例崩溃/进程被 kill)
    await conn.query(
      'DELETE FROM active_sessions WHERE last_heartbeat < NOW(3) - INTERVAL 10 MINUTE');
  } catch (err) {
    // 心跳失败不影响录音
    console.error('heartbeat failed:', err.message);
  } finally {
    conn.release();
  }
}

/** 启动心跳定时器(幂等) */
function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => { heartbeatOnce().catch(() => {}); }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();
}

/** 关闭连接池(测试/退出用) */
async function close() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = { onCallStart, onCallEnd, tableFor, close,
  startActiveSession, endActiveSession, startHeartbeat, heartbeatOnce,
  HEARTBEAT_MS, ACTIVE_TTL_SEC };

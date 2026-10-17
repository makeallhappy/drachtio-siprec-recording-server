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

/** 关闭连接池(测试/退出用) */
async function close() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = { onCallStart, onCallEnd, tableFor, close };

/**
 * 用户管理 —— 从 orekaweb UserService 搬过来(Node 重实现)
 *
 * 数据表(oreka 库):
 *   orkuser        id/firstname/lastname/email/password/disabled/deleted/dateCreated/dateDisabled/dateDeleted
 *   orkloginstring id/loginString/user_id
 *
 * 注意:disabled/deleted 是 binary(1),mysql2 读出来是 Buffer,写入用 Buffer.from([0/1])
 */
const bcrypt = require('bcryptjs');

/** binary(1) Buffer -> bool */
function flag(v) {
  if (v == null) return false;
  if (Buffer.isBuffer(v)) return v.length > 0 && v[0] !== 0;
  return !!v;
}

function toDto(u) {
  return {
    id: u.id,
    firstname: u.firstname,
    lastname: u.lastname,
    email: u.email,
    disabled: flag(u.disabled),
    deleted: flag(u.deleted),
    dateCreated: u.dateCreated,
  };
}

// ==================== 查询 ====================

/** 用户列表(默认不含已删除;includeDeleted=true 全量) */
async function list(pool, includeDeleted = false) {
  const sql = includeDeleted
    ? 'SELECT * FROM orkuser ORDER BY id ASC'
    : 'SELECT * FROM orkuser WHERE deleted = 0 ORDER BY id ASC';
  const [rows] = await pool.query(sql);
  return rows.map(toDto);
}

/** 单个用户 */
async function getById(pool, id) {
  const [rows] = await pool.query('SELECT * FROM orkuser WHERE id = ?', [id]);
  return rows.length ? toDto(rows[0]) : null;
}

/** 用户的 loginString 列表 */
async function getLoginStrings(pool, userId) {
  const [rows] = await pool.query('SELECT id, loginString FROM orkloginstring WHERE user_id = ?', [userId]);
  return rows;
}

// ==================== 创建 ====================

/**
 * 创建用户 + loginString(默认=firstname)
 * @param {object} data {firstname, lastname, email, password, loginString}
 */
async function create(pool, data) {
  const { firstname, lastname, email, password, loginString } = data;
  if (!firstname) throw new Error('firstname 必填');
  if (!password) throw new Error('password 必填');

  const hash = await bcrypt.hash(password, 10);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO orkuser (firstname, lastname, email, password, disabled, deleted, dateCreated)
       VALUES (?,?,?,?,?,?,NOW(3))`,
      [firstname, lastname || '', email || '', hash, Buffer.from([0]), Buffer.from([0])]
    );
    const userId = r.insertId;

    const ls = (loginString && loginString.trim()) || firstname;
    if (ls) {
      await conn.query('INSERT INTO orkloginstring (loginString, user_id) VALUES (?,?)', [ls, userId]);
    }
    await conn.commit();
    return { id: userId, firstname, lastname: lastname || '', email: email || '', disabled: false, deleted: false };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ==================== 更新 ====================

/**
 * 更新用户(部分字段;password 留空不改)
 * @param {object} data {firstname?, lastname?, email?, password?, disabled?}
 */
async function update(pool, id, data) {
  const sets = [];
  const params = [];
  if (data.firstname != null) { sets.push('firstname = ?'); params.push(data.firstname); }
  if (data.lastname != null) { sets.push('lastname = ?'); params.push(data.lastname); }
  if (data.email != null) { sets.push('email = ?'); params.push(data.email); }
  if (data.password != null && data.password !== '') {
    sets.push('password = ?');
    params.push(await bcrypt.hash(data.password, 10));
  }
  if (data.disabled != null) {
    sets.push('disabled = ?');
    params.push(Buffer.from([data.disabled ? 1 : 0]));
    if (data.disabled) { sets.push('dateDisabled = NOW(3)'); }
  }
  if (sets.length === 0) return getById(pool, id);
  params.push(id);
  await pool.query(`UPDATE orkuser SET ${sets.join(', ')} WHERE id = ?`, params);
  return getById(pool, id);
}

// ==================== 删除(软删) ====================

/** 软删:deleted=1 + dateDeleted */
async function remove(pool, id) {
  const [r] = await pool.query(
    'UPDATE orkuser SET deleted = ?, dateDeleted = NOW(3) WHERE id = ?',
    [Buffer.from([1]), id]
  );
  return r.affectedRows > 0;
}

module.exports = { list, getById, getLoginStrings, create, update, remove, toDto };

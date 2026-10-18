/**
 * 登录认证 —— 从 orekaweb 搬过来的验证码 + JWT 逻辑(Node 重实现)
 *
 * - 验证码:svg-captcha(对应 orekaweb 的 easy-captcha),GET /api/captcha
 *   返回 {captchaId, imageBase64(svg data-uri)},答案内存暂存,5 分钟有效,一次性
 * - 登录:POST /api/auth/login {loginString, password, captchaId, captchaCode}
 *   先校验验证码,再查 oreka 库 orkloginstring -> orkuser,bcrypt 校验密码,签 JWT
 * - 保护:requireAuth 中间件,校验 Authorization: Bearer <jwt>
 *
 * 配置:
 *   JWT_SECRET(env,生产必须改) 默认 dev 值
 *   JWT_TTL_MINUTES 默认 120
 */
const svgCaptcha = require('svg-captcha');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'siprec-web-dev-secret-change-me';
const JWT_TTL_MINUTES = Number(process.env.JWT_TTL_MINUTES || 120);
const CAPTCHA_TTL_MS = 5 * 60 * 1000;

// ---- 验证码存储(内存,captchaId -> {answer, expiresAt}) ----
const captchaStore = new Map();

function issueCaptcha() {
  // math 算式验证码(对齐 orekaweb 的算术型),噪点+干扰线
  const cap = svgCaptcha.createMathExpr({
    mathMin: 1, mathMax: 30, mathOperator: '+-',
    noise: 2, color: true, background: '#f0f2f5', width: 130, height: 48, fontSize: 44,
  });
  const id = crypto.randomUUID();
  captchaStore.set(id, { answer: String(cap.text), expiresAt: Date.now() + CAPTCHA_TTL_MS });
  // 顺手清过期
  const now = Date.now();
  for (const [k, v] of captchaStore) if (now > v.expiresAt) captchaStore.delete(k);
  // svg -> base64 data-uri
  const imageBase64 = 'data:image/svg+xml;base64,' + Buffer.from(cap.data).toString('base64');
  return { captchaId: id, imageBase64 };
}

function verifyCaptcha(captchaId, captchaCode) {
  if (!captchaId || !captchaCode) return false;
  const e = captchaStore.get(captchaId);
  captchaStore.delete(captchaId); // 一次性
  if (!e) return false;
  if (Date.now() > e.expiresAt) return false;
  return e.answer.trim().toLowerCase() === String(captchaCode).trim().toLowerCase();
}

// oreka 库 disabled/deleted 是 binary(1),mysql2 返回 Buffer(\x00=启用);统一转成数值判断
function flagIsSet(v) {
  if (v == null) return false;
  if (Buffer.isBuffer(v)) return v.length > 0 && v[0] !== 0;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v !== '\0' && v !== '0' && v !== '';
  return !!v;
}

// ---- 用户认证(查 oreka 库 orkloginstring -> orkuser,bcrypt) ----
/**
 * @param {object} pool oreka 库的 mysql2 pool
 */
async function authenticate(pool, loginString, password) {
  const [rows] = await pool.query(
    `SELECT u.id, u.firstname, u.lastname, u.email, u.password, u.disabled, u.deleted
       FROM orkloginstring ls JOIN orkuser u ON ls.user_id = u.id
      WHERE ls.loginString = ?
      ORDER BY ls.id ASC LIMIT 1`,
    [loginString]
  );
  if (rows.length === 0) return null;
  const u = rows[0];
  if (flagIsSet(u.disabled) || flagIsSet(u.deleted)) return null;
  // BCrypt 校验(orkuser 现已是 BCrypt;$2a$ 前缀)
  const ok = await bcrypt.compare(password, u.password);
  if (!ok) return null;
  return { id: u.id, firstname: u.firstname, lastname: u.lastname, email: u.email };
}

function signToken(user, loginString) {
  return jwt.sign(
    { sub: String(user.id), loginString, firstname: user.firstname, lastname: user.lastname },
    JWT_SECRET,
    { expiresIn: `${JWT_TTL_MINUTES}m` }
  );
}

/** Express 中间件:校验 Bearer JWT */
function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return res.status(401).json({ error: 'missing token' });
  try {
    req.user = jwt.verify(m[1], JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}

module.exports = { issueCaptcha, verifyCaptcha, authenticate, signToken, requireAuth };

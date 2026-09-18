const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { query } = require('./db');
const { config } = require('./config');

function sign(email) {
  return jwt.sign({ sub: email }, config.jwtSecret, { expiresIn: Math.floor(config.jwtExpirationMs / 1000) });
}
function verify(token) { return jwt.verify(token, config.jwtSecret); }
async function register(email, password) {
  const exists = await query('SELECT id FROM users WHERE email = $1 LIMIT 1', [email]);
  if (exists.rowCount) throw Object.assign(new Error('Email already exists'), { status: 409 });
  const hash = await bcrypt.hash(password, 12);
  await query('INSERT INTO users(email, password) VALUES($1, $2)', [email, hash]);
  return 'User registered';
}
async function login(email, password) {
  const result = await query('SELECT email, password FROM users WHERE email = $1 LIMIT 1', [email]);
  if (!result.rowCount || !(await bcrypt.compare(password, result.rows[0].password))) {
    throw Object.assign(new Error('Invalid email or password'), { status: 401 });
  }
  return sign(result.rows[0].email);
}
function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = verify(header.slice(7));
    req.user = { email: payload.sub };
    next();
  } catch { return res.status(401).json({ error: 'Unauthorized' }); }
}
function requireUploadApiKey(req, res, next) {
    const apiKey = req.get('X-API-Key');

    if (!apiKey || apiKey !== config.internalApiKey) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
}
module.exports = { sign, verify, register, login, requireAuth ,requireUploadApiKey};

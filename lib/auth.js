// Accès des poolers : un code par équipe, gardé en mémoire dans un témoin (cookie) signé.
const crypto = require('crypto');

const COOKIE = 'pav_session';
const MAX_AGE_DAYS = 365; // on reste connecté sur son téléphone

function hashCode(code) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(normalizeCode(code), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function checkCode(code, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(normalizeCode(code), salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

// Code facile à dicter au téléphone : pas de 0/O ni 1/I/L.
function generateCode(len = 6) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[crypto.randomInt(chars.length)];
  return out;
}

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setSession(res, payload, secret, secure) {
  const exp = Date.now() + MAX_AGE_DAYS * 864e5;
  const token = sign({ ...payload, exp }, secret);
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_DAYS * 86400}${secure ? '; Secure' : ''}`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function getSession(req, secret) {
  return verify(readCookie(req, COOKIE), secret);
}

module.exports = { hashCode, checkCode, generateCode, setSession, clearSession, getSession };

// Accounts, sessions and API tokens.
//  - Passwords: scrypt (N=2^15, r=8, p=1) with a random 16-byte salt.
//  - Sessions: random 256-bit token in an HttpOnly, SameSite=Strict cookie;
//    only its SHA-256 is stored. Each session carries a CSRF token.
//  - API tokens (for the CLI): "chr_" + 256 random bits; only the hash is stored.
//  - Brute force: per-account lockout after repeated failures, plus IP rate limits.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './http.js';
import { randomToken, safeEqual, sha256 } from './security.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_COOKIE = 'chroma_sid';
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;
const COMMON = new Set(['password', 'password1', 'password123', '1234567890', 'qwertyuiop', '12345678910', 'iloveyou12', 'letmein123', 'administrator', 'welcome123']);

export const USERNAME_RE = /^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?$/;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(actual, expected);
}

// A fixed hash so unknown usernames cost the same time as wrong passwords.
let dummyHash = null;
const getDummy = async () => (dummyHash ||= await hashPassword(randomToken()));

export function validatePassword(password, username) {
  if (typeof password !== 'string' || password.length < 10) throw new HttpError(400, 'password must be at least 10 characters');
  if (password.length > 256) throw new HttpError(400, 'password must be at most 256 characters');
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) throw new HttpError(400, 'that password is too common; pick something less guessable');
  if (username && lower.includes(username.toLowerCase())) throw new HttpError(400, 'password must not contain your username');
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export class Auth {
  constructor(store, { https }) {
    this.store = store;
    this.https = https;
  }

  get db() { return this.store.data; }

  findUser(username) {
    const name = String(username || '').toLowerCase();
    return Object.values(this.db.users).find((u) => u.username === name) || null;
  }

  async signup(username, password) {
    const name = String(username || '').toLowerCase();
    if (!USERNAME_RE.test(name)) throw new HttpError(400, 'username must be 3-32 characters: letters, numbers, - and _');
    validatePassword(password, name);
    if (this.findUser(name)) throw new HttpError(409, 'that username is taken');
    const user = {
      id: this.store.id('usr'),
      username: name,
      password: await hashPassword(password),
      createdAt: new Date().toISOString(),
      failed: 0,
      lockedUntil: 0,
    };
    // re-check after the async hash in case of a concurrent signup
    if (this.findUser(name)) throw new HttpError(409, 'that username is taken');
    this.db.users[user.id] = user;
    this.store.save();
    return user;
  }

  async login(username, password, ip) {
    const user = this.findUser(username);
    if (typeof password !== 'string' || password.length > 256) throw new HttpError(400, 'invalid credentials');
    if (!user) {
      await verifyPassword(password, await getDummy());
      this.store.audit('login.failed', { ip, detail: { username: String(username).slice(0, 40) } });
      throw new HttpError(401, 'wrong username or password');
    }
    if (user.lockedUntil > Date.now()) {
      const mins = Math.ceil((user.lockedUntil - Date.now()) / 60000);
      throw new HttpError(429, `account temporarily locked after failed logins; try again in ${mins} min`);
    }
    if (!(await verifyPassword(password, user.password))) {
      user.failed = (user.failed || 0) + 1;
      if (user.failed >= LOCK_AFTER) {
        user.lockedUntil = Date.now() + LOCK_MS;
        user.failed = 0;
        this.store.audit('account.locked', { userId: user.id, ip });
      }
      this.store.audit('login.failed', { userId: user.id, ip });
      this.store.save();
      throw new HttpError(401, 'wrong username or password');
    }
    user.failed = 0;
    user.lockedUntil = 0;
    this.store.save();
    return user;
  }

  async changePassword(user, current, next) {
    if (!(await verifyPassword(String(current || ''), user.password))) throw new HttpError(401, 'current password is wrong');
    validatePassword(next, user.username);
    user.password = await hashPassword(next);
    // sign out every other session
    for (const [k, s] of Object.entries(this.db.sessions)) if (s.userId === user.id) delete this.db.sessions[k];
    this.store.save();
  }

  createSession(user, req, ip) {
    const token = randomToken();
    const session = {
      userId: user.id,
      csrf: randomToken(24),
      createdAt: Date.now(),
      expires: Date.now() + SESSION_TTL,
      ip,
      ua: String(req.headers['user-agent'] || '').slice(0, 200),
    };
    this.db.sessions[sha256(token)] = session;
    this.pruneSessions();
    this.store.save();
    return { token, session };
  }

  pruneSessions() {
    const now = Date.now();
    for (const [k, s] of Object.entries(this.db.sessions)) if (s.expires < now) delete this.db.sessions[k];
  }

  cookie(token, maxAge = SESSION_TTL / 1000) {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.https ? '; Secure' : ''}`;
  }

  clearCookie() {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.https ? '; Secure' : ''}`;
  }

  destroySession(token) {
    delete this.db.sessions[sha256(token)];
    this.store.save();
  }

  createToken(user, name) {
    const secret = `chr_${randomToken()}`;
    const id = this.store.id('tok');
    this.db.tokens[id] = {
      id,
      userId: user.id,
      name: String(name || 'token').slice(0, 60),
      hash: sha256(secret),
      prefix: secret.slice(0, 8),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.store.save();
    return { id, secret };
  }

  /** Resolve the caller from a session cookie or a Bearer API token. */
  identify(req) {
    const authz = String(req.headers.authorization || '');
    if (authz.startsWith('Bearer ')) {
      const secret = authz.slice(7).trim();
      const hash = sha256(secret);
      const tok = Object.values(this.db.tokens).find((t) => safeEqual(t.hash, hash));
      if (!tok) throw new HttpError(401, 'invalid API token');
      const user = this.db.users[tok.userId];
      if (!user) throw new HttpError(401, 'invalid API token');
      const now = new Date().toISOString();
      if (!tok.lastUsedAt || Date.parse(now) - Date.parse(tok.lastUsedAt) > 60_000) {
        tok.lastUsedAt = now;
        this.store.save();
      }
      return { user, via: 'token', token: tok };
    }
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!sid) return null;
    const session = this.db.sessions[sha256(sid)];
    if (!session || session.expires < Date.now()) return null;
    const user = this.db.users[session.userId];
    if (!user) return null;
    return { user, via: 'session', session, sid };
  }

  publicUser(user) {
    return { id: user.id, username: user.username, createdAt: user.createdAt };
  }
}

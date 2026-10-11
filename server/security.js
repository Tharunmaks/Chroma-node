// Security primitives: response headers, rate limiting, safe paths,
// constant-time comparison, client IP handling and audit logging.
import crypto from 'node:crypto';
import { HttpError } from './http.js';

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) {
    crypto.timingSafeEqual(x, x); // keep timing similar
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

/** Headers for the platform's own pages and API. */
export function siteHeaders({ https, scriptHashes = [] }) {
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.map((h) => `'sha256-${h}'`).join(' ')}`.trim(),
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
  ];
  if (https) csp.push('upgrade-insecure-requests');
  const headers = {
    'Content-Security-Policy': csp.join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Permitted-Cross-Domain-Policies': 'none',
  };
  if (https) headers['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains';
  return headers;
}

/**
 * Headers for user-deployed content. The CSP sandbox gives every deployed
 * page an opaque origin, so it can never read the dashboard's cookies, call
 * the authenticated API or script the platform's pages, even though it is
 * served from the same host.
 */
export function deploymentHeaders({ https }) {
  const headers = {
    // applied to every file, not only HTML: an uploaded SVG or XML document
    // opened directly would otherwise run script on the platform's origin
    'Content-Security-Policy': "sandbox allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock allow-downloads allow-presentation; frame-ancestors 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };
  if (https) headers['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains';
  return headers;
}

/** Fixed-window rate limiter keyed by any string (IP, user, IP+route). */
export class RateLimiter {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
    this.timer = setInterval(() => this.sweep(), Math.max(windowMs, 10_000));
    this.timer.unref();
  }

  take(key) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || now >= e.reset) {
      e = { count: 0, reset: now + this.windowMs };
      this.hits.set(key, e);
    }
    e.count++;
    return { ok: e.count <= this.limit, remaining: Math.max(0, this.limit - e.count), reset: e.reset };
  }

  check(key, res) {
    const r = this.take(key);
    if (res) {
      res.setHeader('RateLimit-Limit', this.limit);
      res.setHeader('RateLimit-Remaining', r.remaining);
    }
    if (!r.ok) {
      const retry = Math.ceil((r.reset - Date.now()) / 1000);
      if (res) res.setHeader('Retry-After', retry);
      throw new HttpError(429, `too many requests; try again in ${retry}s`);
    }
  }

  sweep() {
    const now = Date.now();
    for (const [k, e] of this.hits) if (now >= e.reset) this.hits.delete(k);
  }

  stop() { clearInterval(this.timer); }
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

const MAX_PATH = 256;
/**
 * Validate a relative file path from an upload. Rejects absolute paths,
 * traversal, backslashes, control characters, hidden segments and anything
 * that normalises differently, so paths can be used as storage keys safely.
 */
export function cleanPath(p) {
  if (typeof p !== 'string' || !p.length || p.length > MAX_PATH) throw new HttpError(400, 'invalid file path');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\\]/.test(p) || p.startsWith('/') || p.includes('//')) throw new HttpError(400, `invalid file path: ${JSON.stringify(p.slice(0, 80))}`);
  const parts = p.split('/');
  if (parts.length > 32) throw new HttpError(400, 'file path is nested too deeply');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.startsWith('.')) throw new HttpError(400, `invalid file path: ${JSON.stringify(p.slice(0, 80))}`);
  }
  return parts.join('/');
}

export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const RESERVED_NAMES = new Set(['api', 'www', 'admin', 'app', 'dashboard', 'docs', 'static', 'assets', 'vendor', 'chroma', 'login', 'p', 'd']);

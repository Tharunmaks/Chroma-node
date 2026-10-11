// Small HTTP toolkit: router with :params, body reading with hard limits,
// JSON helpers and typed errors. No framework, no dependencies.

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, ...handlers) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/\*$/, '(?:/(?<wild>.*))?').replace(/:(\w+)/g, (_, k) => {
      keys.push(k);
      return `(?<${k}>[^/]+)`;
    }) + '/?$');
    this.routes.push({ method, re, handlers });
    return this;
  }

  get(p, ...h) { return this.add('GET', p, ...h); }
  post(p, ...h) { return this.add('POST', p, ...h); }
  put(p, ...h) { return this.add('PUT', p, ...h); }
  delete(p, ...h) { return this.add('DELETE', p, ...h); }

  match(method, pathname) {
    let allowed = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) { allowed = true; continue; }
      const params = {};
      for (const [k, v] of Object.entries(m.groups || {})) {
        if (v === undefined) continue;
        try { params[k] = decodeURIComponent(v); } catch { throw new HttpError(400, 'malformed URL'); }
      }
      return { handlers: r.handlers, params };
    }
    return allowed ? { methodNotAllowed: true } : null;
  }
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      reject(new HttpError(413, `request body is larger than ${Math.round(limit / 1024 / 1024)} MB`));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, `request body is larger than ${Math.round(limit / 1024 / 1024)} MB`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJSON(req, limit = 1024 * 1024) {
  const type = String(req.headers['content-type'] || '');
  if (!type.startsWith('application/json')) throw new HttpError(415, 'expected Content-Type: application/json');
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    const value = JSON.parse(buf.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new HttpError(400, 'body must be a JSON object');
  }
}

export function sendJSON(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

export function str(value, name, { min = 0, max = 200, pattern } = {}) {
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string`);
  if (value.length < min) throw new HttpError(400, `${name} must be at least ${min} characters`);
  if (value.length > max) throw new HttpError(400, `${name} must be at most ${max} characters`);
  if (pattern && !pattern.test(value)) throw new HttpError(400, `${name} has an invalid format`);
  return value;
}

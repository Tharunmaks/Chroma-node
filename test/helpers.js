import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';

export async function boot(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chroma-test-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false, rateLimits: { auth: 1000, api: 100000, fn: 1000, compile: 1000, deploy: 1000 }, ...opts });
  return {
    ...srv,
    dataDir,
    async stop() { await srv.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

/** A tiny browser-like client: keeps the session cookie and CSRF token. */
export class Client {
  constructor(base, origin) {
    this.base = base;
    this.origin = origin;
    this.cookie = null;
    this.csrf = null;
    this.token = null;
  }

  async req(method, p, body, extra = {}) {
    const headers = { ...extra };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf && method !== 'GET' && !('x-csrf-token' in extra)) headers['x-csrf-token'] = this.csrf;
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.origin) headers.origin = this.origin;
    const res = await fetch(this.base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    if (data && data.csrf) this.csrf = data.csrf;
    return { status: res.status, data, headers: res.headers };
  }

  async signup(username, password = 'a-very-good-password') {
    return this.req('POST', '/api/auth/signup', { username, password });
  }
}

export const b64 = (s) => Buffer.from(s).toString('base64');
export const file = (p, text) => ({ path: p, data: b64(text) });

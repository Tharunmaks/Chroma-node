// The Chroma HTTP application: website, API, deployment hosting and
// Pyre Functions, wired together with security middleware.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { compileAll, PyreError, VERSION as PYRE_VERSION } from 'pyre-lang';
import { Router, HttpError, readJSON, sendJSON, str } from './http.js';
import { siteHeaders, deploymentHeaders, RateLimiter, clientIp, safeEqual } from './security.js';
import { Store } from './store.js';
import { Auth } from './auth.js';
import { Deployments, DEPLOY_LIMITS } from './deployments.js';
import { resolveSitePath } from './resolve.js';
import { mimeType } from './mime.js';
import { validateInput, runFunction, FN_LIMITS } from './functions.js';

const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_DIR = path.join(ROOT, 'web');
export const TEMPLATES_DIR = path.join(ROOT, 'templates');
export const THREE_DIR = path.resolve(path.dirname(require.resolve('three')), '..');
export const PYRE_DIR = path.dirname(require.resolve('pyre-lang'));
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const PAGES = { '/': 'index.html', '/playground': 'playground.html', '/docs': 'docs.html', '/dashboard': 'dashboard.html', '/engine': 'engine.html' };

/** Public static trees: URL prefix -> directory. Shared with the dev server. */
export const STATIC_TREES = [
  ['/vendor/three/addons/', path.join(THREE_DIR, 'examples', 'jsm')],
  ['/vendor/three/', path.join(THREE_DIR, 'build')],
  ['/vendor/pyre/', PYRE_DIR],
  ['/assets/', path.join(WEB_DIR, 'assets')],
];

// ---------- static files with ETag + gzip ----------
const gzCache = new Map();
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|manifest)|image\/svg)/;

export function sendBuffer(req, res, status, buf, type, headers, etag) {
  const h = { 'Content-Type': type, ...headers };
  if (etag) {
    h.ETag = etag;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, h);
      return res.end();
    }
  }
  let body = buf;
  if (buf.length > 1024 && COMPRESSIBLE.test(type) && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    const key = etag || null;
    let gz = key && gzCache.get(key);
    if (!gz) {
      gz = zlib.gzipSync(buf, { level: 6 });
      if (key) {
        gzCache.set(key, gz);
        if (gzCache.size > 300) gzCache.delete(gzCache.keys().next().value);
      }
    }
    body = gz;
    h['Content-Encoding'] = 'gzip';
    h.Vary = 'Accept-Encoding';
  }
  h['Content-Length'] = body.length;
  res.writeHead(status, h);
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function serveTree(req, res, pathname, headers) {
  for (const [prefix, dir] of STATIC_TREES) {
    if (!pathname.startsWith(prefix)) continue;
    let rel;
    try { rel = decodeURIComponent(pathname.slice(prefix.length)); } catch { return false; }
    const file = path.resolve(dir, rel);
    if (!file.startsWith(dir + path.sep)) return false;
    let stat;
    try { stat = fs.statSync(file); } catch { return false; }
    if (!stat.isFile()) return false;
    const etag = `"${stat.size.toString(36)}-${stat.mtimeMs.toString(36)}"`;
    sendBuffer(req, res, 200, fs.readFileSync(file), mimeType(file), {
      ...headers,
      'Cache-Control': prefix.startsWith('/vendor/') ? 'public, max-age=86400' : 'public, max-age=300',
      // the libraries may be imported by sandboxed (opaque-origin) deployed pages
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    }, etag);
    return true;
  }
  return false;
}

/** Hashes of inline <script> blocks (the import maps) for the page CSP. */
function inlineScriptHashes(html) {
  const out = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    out.push(crypto.createHash('sha256').update(m[1]).digest('base64'));
  }
  return out;
}

export function createApp(options = {}) {
  const cfg = {
    dataDir: options.dataDir || path.join(ROOT, 'data'),
    https: !!options.https,
    trustProxy: !!options.trustProxy,
    allowSignup: options.allowSignup !== false,
    domain: options.domain || null, // serve <project>.<domain> when set
    log: options.log !== false,
  };
  const store = new Store(cfg.dataDir);
  const auth = new Auth(store, { https: cfg.https });
  const deploys = new Deployments(store);
  const rl = { auth: 20, api: 600, fn: 60, compile: 120, deploy: 30, ...(options.rateLimits || {}) };
  const limiters = {
    auth: new RateLimiter({ limit: rl.auth, windowMs: 10 * 60 * 1000 }),
    api: new RateLimiter({ limit: rl.api, windowMs: 60 * 1000 }),
    fn: new RateLimiter({ limit: rl.fn, windowMs: 60 * 1000 }),
    compile: new RateLimiter({ limit: rl.compile, windowMs: 60 * 1000 }),
    deploy: new RateLimiter({ limit: rl.deploy, windowMs: 10 * 60 * 1000 }),
  };

  const pageCache = new Map();
  function page(file) {
    if (!pageCache.has(file) || options.dev) {
      // pages share <!--#head-->, <!--#nav--> and <!--#footer--> partials
      const html = Buffer.from(fs.readFileSync(path.join(WEB_DIR, file), 'utf8')
        .replace(/<!--#(head|nav|footer)-->/g, (_, name) => fs.readFileSync(path.join(WEB_DIR, 'partials', `${name}.html`), 'utf8')));
      pageCache.set(file, { html, hashes: inlineScriptHashes(html.toString('utf8')), etag: `"${crypto.createHash('sha1').update(html).digest('base64url')}"` });
    }
    return pageCache.get(file);
  }

  // ---------- auth helpers ----------
  function requireUser(ctx) {
    const who = auth.identify(ctx.req);
    if (!who) throw new HttpError(401, 'sign in first');
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(ctx.req.method);
    if (who.via === 'session' && unsafe) {
      const token = ctx.req.headers['x-csrf-token'];
      if (!token || !safeEqual(token, who.session.csrf)) throw new HttpError(403, 'missing or invalid CSRF token');
    }
    ctx.who = who;
    return who.user;
  }

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  const api = new Router();

  api.get('/api/health', ({ res }) => sendJSON(res, 200, { ok: true, version: VERSION, pyre: PYRE_VERSION }));

  api.get('/api/me', ({ req, res }) => {
    const who = auth.identify(req);
    if (!who) return sendJSON(res, 200, { user: null, signup: cfg.allowSignup });
    sendJSON(res, 200, { user: auth.publicUser(who.user), csrf: who.via === 'session' ? who.session.csrf : null, via: who.via });
  });

  api.post('/api/auth/signup', async ({ req, res, ip }) => {
    if (!cfg.allowSignup) throw new HttpError(403, 'sign-ups are disabled on this server');
    if (!sameOrigin(req)) throw new HttpError(403, 'cross-origin request rejected');
    limiters.auth.check(`auth:${ip}`, res);
    const body = await readJSON(req);
    const user = await auth.signup(body.username, body.password);
    const { token, session } = auth.createSession(user, req, ip);
    store.audit('user.signup', { userId: user.id, ip });
    sendJSON(res, 201, { user: auth.publicUser(user), csrf: session.csrf }, { 'Set-Cookie': auth.cookie(token) });
  });

  api.post('/api/auth/login', async ({ req, res, ip }) => {
    if (!sameOrigin(req)) throw new HttpError(403, 'cross-origin request rejected');
    limiters.auth.check(`auth:${ip}`, res);
    const body = await readJSON(req);
    const user = await auth.login(body.username, body.password, ip);
    const { token, session } = auth.createSession(user, req, ip);
    store.audit('login', { userId: user.id, ip });
    sendJSON(res, 200, { user: auth.publicUser(user), csrf: session.csrf }, { 'Set-Cookie': auth.cookie(token) });
  });

  api.post('/api/auth/logout', (ctx) => {
    requireUser(ctx);
    if (ctx.who.via === 'session') auth.destroySession(ctx.who.sid);
    sendJSON(ctx.res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
  });

  api.post('/api/auth/password', async (ctx) => {
    const user = requireUser(ctx);
    limiters.auth.check(`auth:${ctx.ip}`, ctx.res);
    const body = await readJSON(ctx.req);
    await auth.changePassword(user, body.current, body.next);
    store.audit('password.changed', { userId: user.id, ip: ctx.ip });
    const { token, session } = auth.createSession(user, ctx.req, ctx.ip);
    sendJSON(ctx.res, 200, { ok: true, csrf: session.csrf }, { 'Set-Cookie': auth.cookie(token) });
  });

  // CLI login: exchange credentials for an API token
  api.post('/api/auth/token', async ({ req, res, ip }) => {
    limiters.auth.check(`auth:${ip}`, res);
    const body = await readJSON(req);
    const user = await auth.login(body.username, body.password, ip);
    const name = str(body.name ?? 'cli', 'name', { max: 60 });
    const { id, secret } = auth.createToken(user, name);
    store.audit('token.created', { userId: user.id, ip, detail: { id, name } });
    sendJSON(res, 201, { id, token: secret, user: auth.publicUser(user) });
  });

  api.get('/api/tokens', (ctx) => {
    const user = requireUser(ctx);
    const tokens = Object.values(store.data.tokens).filter((t) => t.userId === user.id)
      .map(({ id, name, prefix, createdAt, lastUsedAt }) => ({ id, name, prefix, createdAt, lastUsedAt }));
    sendJSON(ctx.res, 200, { tokens });
  });

  api.post('/api/tokens', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJSON(ctx.req);
    const name = str(body.name ?? 'token', 'name', { min: 1, max: 60 });
    if (Object.values(store.data.tokens).filter((t) => t.userId === user.id).length >= 20) throw new HttpError(403, 'limit of 20 tokens reached');
    const { id, secret } = auth.createToken(user, name);
    store.audit('token.created', { userId: user.id, ip: ctx.ip, detail: { id, name } });
    sendJSON(ctx.res, 201, { id, token: secret });
  });

  api.delete('/api/tokens/:id', (ctx) => {
    const user = requireUser(ctx);
    const tok = store.data.tokens[ctx.params.id];
    if (!tok || tok.userId !== user.id) throw new HttpError(404, 'token not found');
    delete store.data.tokens[tok.id];
    store.save();
    store.audit('token.revoked', { userId: user.id, ip: ctx.ip, detail: { id: tok.id } });
    sendJSON(ctx.res, 200, { ok: true });
  });

  api.get('/api/projects', (ctx) => {
    const user = requireUser(ctx);
    const projects = Object.values(store.data.projects).filter((p) => p.ownerId === user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((p) => projectView(p));
    sendJSON(ctx.res, 200, { projects });
  });

  function projectView(p) {
    const list = deploys.listDeployments(p);
    const prod = p.productionId ? store.data.deployments[p.productionId] : null;
    return {
      name: p.name,
      createdAt: p.createdAt,
      url: `/p/${p.name}/`,
      production: prod ? deploys.summary(prod, p) : null,
      deployments: list.length,
      latest: list[0] ? deploys.summary(list[0], p) : null,
    };
  }

  api.post('/api/projects', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJSON(ctx.req);
    const p = deploys.createProject(user, body.name);
    store.audit('project.created', { userId: user.id, ip: ctx.ip, detail: { name: p.name } });
    sendJSON(ctx.res, 201, { project: projectView(p) });
  });

  api.get('/api/projects/:name', (ctx) => {
    const user = requireUser(ctx);
    const p = deploys.ownedProject(user, ctx.params.name);
    sendJSON(ctx.res, 200, { project: projectView(p), deployments: deploys.listDeployments(p).map((d) => deploys.summary(d, p)) });
  });

  api.delete('/api/projects/:name', (ctx) => {
    const user = requireUser(ctx);
    const p = deploys.ownedProject(user, ctx.params.name);
    deploys.deleteProject(p);
    store.audit('project.deleted', { userId: user.id, ip: ctx.ip, detail: { name: p.name } });
    sendJSON(ctx.res, 200, { ok: true });
  });

  api.post('/api/projects/:name/deployments', async (ctx) => {
    const user = requireUser(ctx);
    limiters.deploy.check(`deploy:${user.id}`, ctx.res);
    const p = deploys.ownedProject(user, ctx.params.name);
    // base64 inflates by 4/3, plus JSON framing
    const body = await readJSON(ctx.req, Math.ceil(DEPLOY_LIMITS.maxTotalBytes * 1.4) + 1024 * 1024);
    const d = deploys.create(user, p, body.files, { target: body.target || 'production', source: ctx.who.via === 'token' ? 'cli' : 'dashboard' });
    store.audit('deployment.created', { userId: user.id, ip: ctx.ip, detail: { project: p.name, id: d.id, status: d.status } });
    sendJSON(ctx.res, 201, { deployment: { ...deploys.summary(d, p), log: d.log }, production: `/p/${p.name}/` });
  });

  api.post('/api/projects/:name/templates/:template', (ctx) => {
    const user = requireUser(ctx);
    limiters.deploy.check(`deploy:${user.id}`, ctx.res);
    const p = deploys.ownedProject(user, ctx.params.name);
    const files = readTemplate(ctx.params.template);
    const d = deploys.create(user, p, files, { target: 'production', source: `template:${ctx.params.template}` });
    store.audit('deployment.created', { userId: user.id, ip: ctx.ip, detail: { project: p.name, id: d.id, template: ctx.params.template } });
    sendJSON(ctx.res, 201, { deployment: { ...deploys.summary(d, p), log: d.log }, production: `/p/${p.name}/` });
  });

  api.post('/api/projects/:name/promote', async (ctx) => {
    const user = requireUser(ctx);
    const p = deploys.ownedProject(user, ctx.params.name);
    const body = await readJSON(ctx.req);
    const d = deploys.promote(p, str(body.deploymentId, 'deploymentId', { max: 40 }));
    store.audit('deployment.promoted', { userId: user.id, ip: ctx.ip, detail: { project: p.name, id: d.id } });
    sendJSON(ctx.res, 200, { deployment: deploys.summary(d, p) });
  });

  api.get('/api/deployments/:id', (ctx) => {
    const user = requireUser(ctx);
    const d = store.data.deployments[ctx.params.id];
    const p = d && store.data.projects[d.projectId];
    if (!d || !p || p.ownerId !== user.id) throw new HttpError(404, 'deployment not found');
    sendJSON(ctx.res, 200, { deployment: { ...deploys.summary(d, p), log: d.log, files: Object.entries(d.files).map(([name, f]) => ({ path: name, size: f.size, type: f.type })) } });
  });

  api.delete('/api/deployments/:id', (ctx) => {
    const user = requireUser(ctx);
    const d = store.data.deployments[ctx.params.id];
    const p = d && store.data.projects[d.projectId];
    if (!d || !p || p.ownerId !== user.id) throw new HttpError(404, 'deployment not found');
    deploys.remove(p, d.id);
    store.audit('deployment.deleted', { userId: user.id, ip: ctx.ip, detail: { project: p.name, id: d.id } });
    sendJSON(ctx.res, 200, { ok: true });
  });

  api.get('/api/audit', (ctx) => {
    const user = requireUser(ctx);
    const events = store.data.audit.filter((e) => e.userId === user.id).slice(-100).reverse();
    sendJSON(ctx.res, 200, { events });
  });

  api.get('/api/templates', ({ res }) => {
    sendJSON(res, 200, { templates: listTemplates() });
  });

  // Public compile endpoint (the CLI and docs use it; the playground compiles locally)
  api.post('/api/compile', async ({ req, res, ip }) => {
    limiters.compile.check(`compile:${ip}`, res);
    const body = await readJSON(req, 300 * 1024);
    const source = str(body.source, 'source', { max: 256 * 1024 });
    try {
      sendJSON(res, 200, { ok: true, ...compileAll(source, { filename: 'input.pyre' }) });
    } catch (err) {
      if (!(err instanceof PyreError)) throw err;
      sendJSON(res, 422, { ok: false, error: { ...err.toJSON(), text: err.format() } });
    }
  });

  // Pyre Functions: POST /api/fn/<project>/<name> runs api/<name>.pyre
  api.add('OPTIONS', '/api/fn/:project/*', ({ res }) => {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
    });
    res.end();
  });
  api.post('/api/fn/:project/*', async ({ req, res, ip, params }) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    limiters.fn.check(`fn:${ip}`, res);
    const p = deploys.project(String(params.project).toLowerCase());
    const d = p && p.productionId && store.data.deployments[p.productionId];
    const fn = d && d.functions.find((f) => f.name === params.wild);
    if (!fn) throw new HttpError(404, 'function not found');
    const body = await readJSON(req, 16 * 1024 * 1024);
    const meta = JSON.parse(store.getBlob(d.files[`${fn.path}.json`].hash).toString('utf8')).meta;
    const input = validateInput(body, meta);
    const source = store.getBlob(d.files[fn.path].hash).toString('utf8');
    const result = await runFunction(source, input);
    sendJSON(res, 200, { buffers: result.buffers, ms: result.ms });
  });

  // ---------- templates ----------
  function listTemplates() {
    if (!fs.existsSync(TEMPLATES_DIR)) return [];
    return fs.readdirSync(TEMPLATES_DIR).filter((n) => fs.existsSync(path.join(TEMPLATES_DIR, n, 'template.json'))).map((n) => {
      const info = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, n, 'template.json'), 'utf8'));
      return { id: n, name: info.name, description: info.description };
    });
  }
  function readTemplate(name) {
    if (!/^[a-z0-9-]+$/.test(name) || !listTemplates().some((t) => t.id === name)) throw new HttpError(404, 'template not found');
    const base = path.join(TEMPLATES_DIR, name);
    const files = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(abs);
        else if (ent.name !== 'template.json') files.push({ path: path.relative(base, abs).split(path.sep).join('/'), data: fs.readFileSync(abs).toString('base64') });
      }
    };
    walk(base);
    return files;
  }

  // ---------- deployed sites ----------
  function serveDeployment(req, res, d, rest, basePath) {
    const has = (p) => Object.hasOwn(d.files, p);
    const r = resolveSitePath(has, rest, d.config);
    if (r.redirect) {
      res.writeHead(308, { Location: r.redirect });
      return res.end();
    }
    const headersFor = () => deploymentHeaders({ https: cfg.https });
    if (!r.path) {
      const body = Buffer.from(`<!doctype html><meta charset="utf-8"><title>404</title><body style="font:16px system-ui;background:#0b0b10;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div><h1>404</h1><p>Nothing at <code>${escapeHtml(basePath + rest)}</code> in this deployment.</p></div>`);
      return sendBuffer(req, res, 404, body, 'text/html; charset=utf-8', { ...headersFor('x.html'), 'Cache-Control': 'no-store' });
    }
    const f = d.files[r.path];
    sendBuffer(req, res, r.status, store.getBlob(f.hash), f.type, { ...headersFor(r.path), 'Cache-Control': 'public, max-age=0, must-revalidate' }, `"${f.hash.slice(0, 32)}"`);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  // ---------- request entry point ----------
  async function handle(req, res) {
    const started = Date.now();
    const ip = clientIp(req, cfg.trustProxy);
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400);
      return res.end();
    }
    const pathname = url.pathname;
    res.on('finish', () => {
      if (cfg.log) console.log(`${new Date().toISOString()} ${ip} ${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    });
    try {
      if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'].includes(req.method)) throw new HttpError(405, 'method not allowed');
      if (req.url.length > 4096) throw new HttpError(414, 'URL too long');

      // <project>.<domain> hosting
      if (cfg.domain) {
        const host = String(req.headers.host || '').split(':')[0].toLowerCase();
        if (host.endsWith(`.${cfg.domain}`)) {
          const name = host.slice(0, -cfg.domain.length - 1);
          const p = deploys.project(name);
          const d = p && p.productionId && store.data.deployments[p.productionId];
          if (!d) throw new HttpError(404, 'no production deployment for this project');
          return serveDeployment(req, res, d, pathname, '/');
        }
      }

      if (pathname.startsWith('/api/')) {
        limiters.api.check(`api:${ip}`, res);
        for (const [k, v] of Object.entries(siteHeaders({ https: cfg.https }))) res.setHeader(k, v);
        const m = api.match(req.method, pathname);
        if (!m) throw new HttpError(404, 'no such API route');
        if (m.methodNotAllowed) throw new HttpError(405, 'method not allowed');
        const ctx = { req, res, ip, params: m.params, url };
        for (const h of m.handlers) await h(ctx);
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');

      const dm = /^\/(p|d)\/([^/]+)(\/.*)?$/.exec(pathname);
      if (dm) {
        const [, kind, id, rest] = dm;
        if (rest === undefined) {
          res.writeHead(308, { Location: `/${kind}/${id}/` });
          return res.end();
        }
        let d = null;
        if (kind === 'd') d = store.data.deployments[id];
        else {
          const p = deploys.project(id.toLowerCase());
          d = p && p.productionId ? store.data.deployments[p.productionId] : null;
        }
        if (!d) throw new HttpError(404, kind === 'p' ? 'this project has no production deployment yet' : 'deployment not found');
        return serveDeployment(req, res, d, rest.slice(1), `/${kind}/${id}/`);
      }

      const headers = siteHeaders({ https: cfg.https });
      if (pathname === '/assets/js/pyre-worker.js') {
        // the CPU worker may evaluate Pyre's generated JS, but nothing else:
        // no network, no DOM (it's a worker), and the page CSP stays eval-free
        headers['Content-Security-Policy'] = "default-src 'none'; script-src 'self' 'unsafe-eval'";
      }
      if (serveTree(req, res, pathname, headers)) return;

      const pageFile = PAGES[pathname] || PAGES[pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/'];
      if (pageFile) {
        const pg = page(pageFile);
        return sendBuffer(req, res, 200, pg.html, 'text/html; charset=utf-8', {
          ...siteHeaders({ https: cfg.https, scriptHashes: pg.hashes }),
          'Cache-Control': 'no-cache',
        }, pg.etag);
      }
      if (pathname === '/favicon.ico' || pathname === '/favicon.svg') {
        return serveTree(req, res, '/assets/favicon.svg', headers) || (res.writeHead(404), res.end());
      }
      if (pathname === '/robots.txt') {
        return sendBuffer(req, res, 200, Buffer.from('User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /d/\n'), 'text/plain; charset=utf-8', headers);
      }
      throw new HttpError(404, 'page not found');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      const message = status === 500 ? 'internal server error' : err.message;
      if (res.headersSent) return res.end();
      if (pathname.startsWith('/api/')) return sendJSON(res, status, { error: message });
      const html = Buffer.from(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${status} · Chroma</title><link rel="stylesheet" href="/assets/css/site.css"><body class="error-page"><main><p class="eyebrow">Error ${status}</p><h1>${escapeHtml(message)}</h1><p><a class="btn" href="/">Back to Chroma</a></p></main></body></html>`);
      sendBuffer(req, res, status, html, 'text/html; charset=utf-8', { ...siteHeaders({ https: cfg.https }), 'Cache-Control': 'no-store' });
    }
  }

  return {
    handle,
    store,
    auth,
    deploys,
    close() {
      Object.values(limiters).forEach((l) => l.stop());
      store.close();
    },
    limits: { deploy: DEPLOY_LIMITS, fn: FN_LIMITS },
  };
}

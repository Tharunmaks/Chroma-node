// The Chroma HTTP application: website, API, deployment hosting and
// Pyre Functions, wired together with security middleware.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { compileAll, PyreError, VERSION as PYRE_VERSION } from 'pyre-lang';
import { Router, HttpError, readJSON, readBody, sendJSON, str } from './http.js';
import { siteHeaders, deploymentHeaders, RateLimiter, clientIp, safeEqual } from './security.js';
import { Store } from './store.js';
import { Auth } from './auth.js';
import { Deployments, DEPLOY_LIMITS } from './deployments.js';
import { resolveSitePath } from './resolve.js';
import { mimeType } from './mime.js';
import { validateInput, runFunction, FN_LIMITS } from './functions.js';
import { openDatabase } from './sqlite.js';
import { Analytics } from './analytics.js';
import { ProjectDatabase, DB_LIMITS } from './database.js';
import { Models } from './models.js';
import { runJsFunction, toHttp } from './js-functions.js';
import { isHtml } from './mime.js';

const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_DIR = path.join(ROOT, 'web');
export const TEMPLATES_DIR = path.join(ROOT, 'templates');
export const THREE_DIR = path.resolve(path.dirname(require.resolve('three')), '..');
export const PYRE_DIR = path.dirname(require.resolve('pyre-lang'));
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const PAGES = {
  '/': 'index.html', '/playground': 'playground.html', '/docs': 'docs.html', '/dashboard': 'dashboard.html', '/engine': 'engine.html',
  '/models': 'models.html', '/studio': 'studio.html', '/torch': 'torch.html', '/platform': 'platform.html',
};

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
  res.bodyBytes = body.length;
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
    allowJsFunctions: options.allowJsFunctions !== false,
    domain: options.domain || null, // serve <project>.<domain> when set
    log: options.log !== false,
  };
  const store = new Store(cfg.dataDir);
  const auth = new Auth(store, { https: cfg.https });
  const deploys = new Deployments(store);
  const sql = openDatabase(cfg.dataDir);
  const analytics = new Analytics(sql);
  const pdb = new ProjectDatabase(sql);
  const models = new Models(sql);
  const usernames = (uid) => store.data.users[uid]?.username || 'unknown';
  const streams = new Set();
  const rl = { auth: 20, api: 600, fn: 60, compile: 120, deploy: 30, ...(options.rateLimits || {}) };
  const limiters = {
    auth: new RateLimiter({ limit: rl.auth, windowMs: 10 * 60 * 1000 }),
    api: new RateLimiter({ limit: rl.api, windowMs: 60 * 1000 }),
    fn: new RateLimiter({ limit: rl.fn, windowMs: 60 * 1000 }),
    compile: new RateLimiter({ limit: rl.compile, windowMs: 60 * 1000 }),
    deploy: new RateLimiter({ limit: rl.deploy, windowMs: 10 * 60 * 1000 }),
    db: new RateLimiter({ limit: rl.db || 300, windowMs: 60 * 1000 }),
    event: new RateLimiter({ limit: rl.event || 120, windowMs: 60 * 1000 }),
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
    analytics.deleteProject(p.id);
    pdb.dropProject(p.id);
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
    // templates may declare database collections they expect
    const info = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, ctx.params.template, 'template.json'), 'utf8'));
    for (const c of info.collections || []) pdb.setRules(p.id, c.name, { read: c.read, write: c.write });
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
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
    });
    res.end();
  });
  async function functionHandler({ req, res, ip, params, url }) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    limiters.fn.check(`fn:${ip}`, res);
    const p = deploys.project(String(params.project).toLowerCase());
    const d = p && p.productionId && store.data.deployments[p.productionId];
    const fn = d && d.functions.find((f) => f.name === params.wild);
    if (!fn) throw new HttpError(404, 'function not found');
    const started = performance.now();
    let status = 200;
    try {
      if ((fn.type || 'pyre') === 'pyre') {
        if (req.method !== 'POST') throw new HttpError(405, 'Pyre functions take POST requests');
        const body = await readJSON(req, 16 * 1024 * 1024);
        const meta = JSON.parse(store.getBlob(d.files[`${fn.path}.json`].hash).toString('utf8')).meta;
        const input = validateInput(body, meta);
        const source = store.getBlob(d.files[fn.path].hash).toString('utf8');
        const result = await runFunction(source, input);
        sendJSON(res, 200, { buffers: result.buffers, ms: result.ms });
        return;
      }
      if (!cfg.allowJsFunctions) throw new HttpError(501, 'JS server functions are disabled on this server (it was started with ALLOW_JS_FUNCTIONS=0)');
      let body = null;
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        const raw = await readBody(req, 1024 * 1024);
        const text = raw.toString('utf8');
        body = String(req.headers['content-type'] || '').startsWith('application/json') && text ? (() => { try { return JSON.parse(text); } catch { throw new HttpError(400, 'invalid JSON body'); } })() : text;
      }
      const request = {
        method: req.method,
        path: `/${params.wild}`,
        query: Object.fromEntries(url.searchParams),
        headers: Object.fromEntries(['content-type', 'accept', 'user-agent', 'referer', 'accept-language'].filter((h) => req.headers[h]).map((h) => [h, String(req.headers[h]).slice(0, 500)])),
        body,
        file: fn.path,
      };
      const ops = {
        list: ([c, q = {}]) => { pdb.collection(p.id, c); return pdb.query(p.id, c, { where: q.where, order: q.order, limit: q.limit, offset: q.offset }); },
        get: ([c, id]) => { pdb.collection(p.id, c); return pdb.get(p.id, c, id); },
        add: ([c, doc]) => { pdb.collection(p.id, c, { create: true }); return pdb.add(p.id, c, doc); },
        set: ([c, id, doc]) => { pdb.collection(p.id, c, { create: true }); return pdb.set(p.id, c, id, doc); },
        update: ([c, id, doc]) => { pdb.collection(p.id, c); return pdb.set(p.id, c, id, doc, { merge: true }); },
        remove: ([c, id]) => { pdb.collection(p.id, c); pdb.remove(p.id, c, id); return true; },
      };
      const source = store.getBlob(d.files[fn.path].hash).toString('utf8');
      const { response } = await runJsFunction(source, request, { db: async (op, args) => { if (!Object.hasOwn(ops, op)) throw new Error('unknown operation'); return ops[op](args); } });
      const out = toHttp(response);
      status = out.status;
      res.writeHead(out.status, { ...out.headers, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(out.body) });
      res.end(req.method === 'HEAD' ? undefined : out.body);
    } catch (err) {
      status = err.status || 500;
      if (err.detail) {
        sendJSON(res, status, { error: err.message, detail: err.detail, logs: err.logs });
        return;
      }
      throw err;
    } finally {
      analytics.record(p.id, { kind: 'fn', name: fn.name, status, ms: performance.now() - started, ip, ua: String(req.headers['user-agent'] || ''), host: req.headers.host });
    }
  }
  for (const m of ['get', 'post', 'put', 'delete']) api[m]('/api/fn/:project/*', functionHandler);
  api.add('PATCH', '/api/fn/:project/*', functionHandler);

  // ---------- Server-Sent Events helper ----------
  function openStream(req, res, { cors = false } = {}) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {}),
    });
    res.write('retry: 2000\n\n');
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    const cleanups = [() => clearInterval(ping)];
    const close = () => { for (const c of cleanups.splice(0)) c(); streams.delete(close); };
    streams.add(close);
    req.on('close', close);
    return { send, onClose: (fn) => cleanups.push(fn), end: () => { close(); res.end(); } };
  }

  // ---------- analytics ----------
  api.get('/api/projects/:name/analytics', (ctx) => {
    const user = requireUser(ctx);
    const p = deploys.ownedProject(user, ctx.params.name);
    const range = String(ctx.url.searchParams.get('range') || '24h');
    sendJSON(ctx.res, 200, analytics.summary(p.id, range));
  });

  api.get('/api/projects/:name/analytics/stream', (ctx) => {
    const user = requireUser(ctx);
    const p = deploys.ownedProject(user, ctx.params.name);
    const s = openStream(ctx.req, ctx.res);
    s.send('live', { visitors: analytics.live(p.id) });
    const onHit = (hit) => s.send('hit', hit);
    analytics.on(p.id, onHit);
    const tick = setInterval(() => s.send('live', { visitors: analytics.live(p.id) }), 5000);
    s.onClose(() => { analytics.off(p.id, onHit); clearInterval(tick); });
  });

  // custom events from deployed pages: POST /api/a/<project>/event {name}
  api.add('OPTIONS', '/api/a/:project/event', ({ res }) => {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
    res.end();
  });
  api.post('/api/a/:project/event', async ({ req, res, ip, params }) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    limiters.event.check(`event:${ip}`, res);
    const p = deploys.project(String(params.project).toLowerCase());
    if (!p) throw new HttpError(404, 'project not found');
    const body = await readJSON(req, 4096);
    const name = str(body.name, 'name', { min: 1, max: 64, pattern: /^[\w .:/-]+$/ });
    analytics.record(p.id, { kind: 'event', name, path: typeof body.path === 'string' ? body.path : null, ip, ua: String(req.headers['user-agent'] || ''), ref: req.headers.referer, host: req.headers.host });
    sendJSON(res, 202, { ok: true });
  });

  // ---------- project database (owner) ----------
  api.get('/api/projects/:name/db', (ctx) => {
    const user = requireUser(ctx);
    const p = deploys.ownedProject(user, ctx.params.name);
    sendJSON(ctx.res, 200, { collections: pdb.collections(p.id), limits: DB_LIMITS });
  });
  api.post('/api/projects/:name/db', async (ctx) => {
    const user = requireUser(ctx);
    const p = deploys.ownedProject(user, ctx.params.name);
    const body = await readJSON(ctx.req);
    pdb.collection(p.id, str(body.name, 'name', { max: 40 }), { create: true });
    const rules = pdb.setRules(p.id, body.name, { read: body.read, write: body.write });
    store.audit('db.collection.created', { userId: user.id, ip: ctx.ip, detail: { project: p.name, collection: body.name } });
    sendJSON(ctx.res, 201, { collection: rules });
  });
  api.put('/api/projects/:name/db/:col/rules', async (ctx) => {
    const user = requireUser(ctx);
    const p = deploys.ownedProject(user, ctx.params.name);
    const body = await readJSON(ctx.req);
    const rules = pdb.setRules(p.id, ctx.params.col, body);
    store.audit('db.rules.changed', { userId: user.id, ip: ctx.ip, detail: { project: p.name, collection: ctx.params.col, read: rules.read, write: rules.write } });
    sendJSON(ctx.res, 200, { collection: rules });
  });
  api.delete('/api/projects/:name/db/:col', (ctx) => {
    const user = requireUser(ctx);
    const p = deploys.ownedProject(user, ctx.params.name);
    pdb.dropCollection(p.id, ctx.params.col);
    store.audit('db.collection.deleted', { userId: user.id, ip: ctx.ip, detail: { project: p.name, collection: ctx.params.col } });
    sendJSON(ctx.res, 200, { ok: true });
  });
  api.get('/api/projects/:name/db/:col', (ctx) => {
    const user = requireUser(ctx);
    const p = deploys.ownedProject(user, ctx.params.name);
    pdb.collection(p.id, ctx.params.col);
    sendJSON(ctx.res, 200, pdb.query(p.id, ctx.params.col, queryParams(ctx.url)));
  });
  api.post('/api/projects/:name/db/:col/docs', async (ctx) => {
    const user = requireUser(ctx);
    const p = deploys.ownedProject(user, ctx.params.name);
    pdb.collection(p.id, ctx.params.col, { create: true });
    sendJSON(ctx.res, 201, { doc: pdb.add(p.id, ctx.params.col, await readJSON(ctx.req, DB_LIMITS.docBytes * 2)) });
  });
  api.delete('/api/projects/:name/db/:col/docs/:id', (ctx) => {
    const user = requireUser(ctx);
    const p = deploys.ownedProject(user, ctx.params.name);
    pdb.collection(p.id, ctx.params.col);
    pdb.remove(p.id, ctx.params.col, ctx.params.id);
    sendJSON(ctx.res, 200, { ok: true });
  });

  function queryParams(url) {
    return { where: url.searchParams.getAll('where'), order: url.searchParams.get('order'), limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') };
  }

  // ---------- project database (public, for deployed sites) ----------
  // /api/db/<project>/<collection>[/<id>|/stream]. Access follows the
  // collection's rules; an owner's API token (Bearer) bypasses them.
  api.add('OPTIONS', '/api/db/:project/*', ({ res }) => {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '600' });
    res.end();
  });
  async function publicDb(ctx) {
    const { req, res, ip, params } = ctx;
    res.setHeader('Access-Control-Allow-Origin', '*');
    limiters.db.check(`db:${ip}`, res);
    const p = deploys.project(String(params.project).toLowerCase());
    if (!p) throw new HttpError(404, 'project not found');
    const [col, id, extra] = String(params.wild || '').split('/');
    if (!col || extra !== undefined) throw new HttpError(404, 'use /api/db/<project>/<collection>[/<id>]');
    const c = pdb.collection(p.id, col);
    let isOwner = false;
    if (String(req.headers.authorization || '').startsWith('Bearer ')) {
      const who = auth.identify(req);
      isOwner = who && who.user.id === p.ownerId;
      if (!isOwner) throw new HttpError(403, 'that token does not own this project');
    }
    const started = performance.now();
    const record = (status) => analytics.record(p.id, { kind: 'db', name: `${req.method} ${col}`, status, ms: performance.now() - started, ip, ua: String(req.headers['user-agent'] || ''), host: req.headers.host });
    if (req.method === 'GET' && id === 'stream') {
      pdb.authorize(c, 'read', isOwner);
      const s = openStream(req, res, { cors: true });
      const onChange = (change) => s.send(change.type, change);
      pdb.on(`${p.id}/${col}`, onChange);
      s.onClose(() => pdb.off(`${p.id}/${col}`, onChange));
      return;
    }
    if (req.method === 'GET') {
      pdb.authorize(c, 'read', isOwner);
      record(200);
      return sendJSON(res, 200, id ? { doc: pdb.get(p.id, col, id) } : pdb.query(p.id, col, queryParams(ctx.url)), { 'Access-Control-Allow-Origin': '*' });
    }
    if (req.method === 'POST' && !id) {
      pdb.authorize(c, 'create', isOwner);
      const doc = pdb.add(p.id, col, await readJSON(req, DB_LIMITS.docBytes * 2));
      record(201);
      return sendJSON(res, 201, { doc }, { 'Access-Control-Allow-Origin': '*' });
    }
    if ((req.method === 'PUT' || req.method === 'PATCH') && id) {
      pdb.authorize(c, 'write', isOwner);
      const doc = pdb.set(p.id, col, id, await readJSON(req, DB_LIMITS.docBytes * 2), { merge: req.method === 'PATCH' });
      record(200);
      return sendJSON(res, 200, { doc }, { 'Access-Control-Allow-Origin': '*' });
    }
    if (req.method === 'DELETE' && id) {
      pdb.authorize(c, 'write', isOwner);
      pdb.remove(p.id, col, id);
      record(200);
      return sendJSON(res, 200, { ok: true }, { 'Access-Control-Allow-Origin': '*' });
    }
    throw new HttpError(405, 'method not allowed here');
  }
  for (const m of ['get', 'post', 'put', 'delete']) api[m]('/api/db/:project/*', publicDb);
  api.add('PATCH', '/api/db/:project/*', publicDb);

  // ---------- saved models ----------
  api.get('/api/models', (ctx) => {
    const user = requireUser(ctx);
    sendJSON(ctx.res, 200, { models: models.list(user.id) });
  });
  api.get('/api/models/gallery', (ctx) => {
    sendJSON(ctx.res, 200, models.gallery({ limit: ctx.url.searchParams.get('limit'), offset: ctx.url.searchParams.get('offset') }, usernames));
  });
  api.post('/api/models', async (ctx) => {
    const user = requireUser(ctx);
    const m = models.create(user.id, await readJSON(ctx.req, 64 * 1024));
    store.audit('model.saved', { userId: user.id, ip: ctx.ip, detail: { id: m.id, name: m.name } });
    sendJSON(ctx.res, 201, { model: m });
  });
  api.get('/api/models/:id', (ctx) => {
    const who = auth.identify(ctx.req);
    sendJSON(ctx.res, 200, { model: models.get(ctx.params.id, who?.user.id, usernames) });
  });
  api.put('/api/models/:id', async (ctx) => {
    const user = requireUser(ctx);
    sendJSON(ctx.res, 200, { model: models.update(ctx.params.id, user.id, await readJSON(ctx.req, 64 * 1024)) });
  });
  api.delete('/api/models/:id', (ctx) => {
    const user = requireUser(ctx);
    models.remove(ctx.params.id, user.id);
    sendJSON(ctx.res, 200, { ok: true });
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
  function serveDeployment(req, res, d, rest, basePath, { track = false } = {}) {
    const has = (p) => Object.hasOwn(d.files, p);
    const r = resolveSitePath(has, rest, d.config);
    if (track) {
      // page views (HTML and 404s) feed the project's live analytics
      const started = performance.now();
      res.once('finish', () => {
        if (req.method !== 'GET' || (r.path && !isHtml(r.path) && r.status < 400)) return;
        analytics.record(d.projectId, {
          kind: 'page', path: '/' + rest, status: res.statusCode, ms: performance.now() - started, bytes: res.bodyBytes || 0,
          ref: req.headers.referer, ip: clientIp(req, cfg.trustProxy), ua: String(req.headers['user-agent'] || ''), host: req.headers.host,
        });
      });
    }
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
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) throw new HttpError(405, 'method not allowed');
      if (req.url.length > 4096) throw new HttpError(414, 'URL too long');

      // <project>.<domain> hosting
      if (cfg.domain) {
        const host = String(req.headers.host || '').split(':')[0].toLowerCase();
        if (host.endsWith(`.${cfg.domain}`)) {
          const name = host.slice(0, -cfg.domain.length - 1);
          const p = deploys.project(name);
          const d = p && p.productionId && store.data.deployments[p.productionId];
          if (!d) throw new HttpError(404, 'no production deployment for this project');
          return serveDeployment(req, res, d, pathname, '/', { track: true });
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
        return serveDeployment(req, res, d, rest.slice(1), `/${kind}/${id}/`, { track: kind === 'p' });
      }

      const headers = siteHeaders({ https: cfg.https });
      if (/^\/assets\/js\/[a-z]+-worker\.js$/.test(pathname)) {
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
    analytics,
    pdb,
    models,
    close() {
      Object.values(limiters).forEach((l) => l.stop());
      for (const c of [...streams]) c();
      analytics.close();
      sql.close();
      store.close();
    },
    limits: { deploy: DEPLOY_LIMITS, fn: FN_LIMITS },
  };
}

// `chroma dev`: serves a site folder exactly like a deployment would, with
// on-the-fly Pyre compilation, live reload, a compile-error overlay and
// local Pyre Functions. Binds to localhost only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { compileAll, PyreError } from 'pyre-lang';
import { resolveSitePath } from './resolve.js';
import { mimeType, isHtml } from './mime.js';
import { serveTree, sendBuffer } from './app.js';
import { deploymentHeaders } from './security.js';
import { sendJSON, readJSON, HttpError } from './http.js';
import { validateInput, runFunction } from './functions.js';
import { runJsFunction, toHttp } from './js-functions.js';
import { openDatabase } from './sqlite.js';
import { ProjectDatabase } from './database.js';
import { readBody } from './http.js';

const CLIENT = `<script>(() => {
  const es = new EventSource('/__chroma/events');
  let box;
  es.addEventListener('reload', () => location.reload());
  es.addEventListener('pyre-error', (e) => {
    if (!box) { box = document.createElement('pre'); box.style.cssText = 'position:fixed;inset:auto 16px 16px 16px;z-index:2147483647;max-height:50vh;overflow:auto;margin:0;padding:16px 18px;border-radius:12px;background:#1a0b10f2;color:#ff8fa3;font:13px/1.5 ui-monospace,monospace;border:1px solid #ff5c7a66;white-space:pre-wrap'; document.documentElement.append(box); }
    box.textContent = 'Pyre compile error\\n\\n' + JSON.parse(e.data).text;
  });
})();</script>`;

export function startDevServer({ dir, port = 5173, host = '127.0.0.1', log = true } = {}) {
  const root = path.resolve(dir);
  const clients = new Set();
  // an in-memory database: everything is allowed locally, nothing is persisted
  const sql = openDatabase(null);
  const pdb = new ProjectDatabase(sql);
  const PID = 'dev';
  const inRoot = (rel) => {
    const abs = path.resolve(root, rel);
    return abs === root || abs.startsWith(root + path.sep) ? abs : null;
  };
  const isFile = (rel) => {
    const abs = inRoot(rel);
    try { return !!abs && fs.statSync(abs).isFile(); } catch { return false; }
  };
  // generated outputs exist virtually next to each .pyre file
  const generated = (rel) => {
    const m = /^(.*)\.(glsl|wgsl)$/.exec(rel) || /^(.*\.pyre)\.json$/.exec(rel);
    if (!m) return null;
    const src = rel.endsWith('.json') ? m[1] : `${m[1]}.pyre`;
    return isFile(src) ? src : null;
  };
  const has = (rel) => isFile(rel) || !!generated(rel);

  function compileFile(rel) {
    return compileAll(fs.readFileSync(inRoot(rel), 'utf8'), { filename: rel });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (log && pathname !== '/__chroma/events') res.on('finish', () => console.log(`  ${res.statusCode} ${req.method} ${pathname}`));
    try {
      if (pathname === '/__chroma/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
        res.write('retry: 1000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (/^\/api\/(fn|db|a)\//.test(pathname) && req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' });
        return res.end();
      }
      if (/^\/api\/a\//.test(pathname)) return sendJSON(res, 202, { ok: true }, { 'Access-Control-Allow-Origin': '*' });
      const dbm = /^\/api\/db\/[^/]+\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
      if (dbm) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        const [, col, id] = dbm;
        pdb.collection(PID, col, { create: true });
        if (req.method === 'GET' && id === 'stream') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
          const on = (c) => res.write(`event: ${c.type}\ndata: ${JSON.stringify(c)}\n\n`);
          pdb.on(`${PID}/${col}`, on);
          req.on('close', () => pdb.off(`${PID}/${col}`, on));
          return;
        }
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJSON(req, 64 * 1024) : null;
        if (req.method === 'GET') return sendJSON(res, 200, id ? { doc: pdb.get(PID, col, id) } : pdb.query(PID, col, { where: url.searchParams.getAll('where'), order: url.searchParams.get('order'), limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') }));
        if (req.method === 'POST' && !id) return sendJSON(res, 201, { doc: pdb.add(PID, col, body) });
        if ((req.method === 'PUT' || req.method === 'PATCH') && id) return sendJSON(res, 200, { doc: pdb.set(PID, col, id, body, { merge: req.method === 'PATCH' }) });
        if (req.method === 'DELETE' && id) { pdb.remove(PID, col, id); return sendJSON(res, 200, { ok: true }); }
        throw new HttpError(405, 'method not allowed');
      }
      const fn = /^\/api\/fn\/[^/]+\/(.+)$/.exec(pathname);
      if (fn) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        const jsRel = `api/${fn[1]}.js`;
        if (isFile(jsRel)) {
          let body = null;
          if (req.method !== 'GET' && req.method !== 'DELETE') {
            const text = (await readBody(req, 1024 * 1024)).toString('utf8');
            body = String(req.headers['content-type'] || '').startsWith('application/json') && text ? JSON.parse(text) : text;
          }
          const ops = {
            list: ([c, q = {}]) => { pdb.collection(PID, c, { create: true }); return pdb.query(PID, c, q); },
            get: ([c, i]) => { pdb.collection(PID, c, { create: true }); return pdb.get(PID, c, i); },
            add: ([c, d]) => { pdb.collection(PID, c, { create: true }); return pdb.add(PID, c, d); },
            set: ([c, i, d]) => { pdb.collection(PID, c, { create: true }); return pdb.set(PID, c, i, d); },
            update: ([c, i, d]) => { pdb.collection(PID, c, { create: true }); return pdb.set(PID, c, i, d, { merge: true }); },
            remove: ([c, i]) => { pdb.collection(PID, c, { create: true }); pdb.remove(PID, c, i); return true; },
          };
          try {
            const { response, logs } = await runJsFunction(fs.readFileSync(inRoot(jsRel), 'utf8'), {
              method: req.method, path: `/${fn[1]}`, query: Object.fromEntries(url.searchParams), headers: { 'content-type': String(req.headers['content-type'] || '') }, body, file: jsRel,
            }, { db: async (op, args) => ops[op](args) });
            if (log) for (const l of logs) console.log(`  [${jsRel}] ${l}`);
            const out = toHttp(response);
            res.writeHead(out.status, { ...out.headers, 'Access-Control-Allow-Origin': '*' });
            return res.end(out.body);
          } catch (err) {
            if (log && err.detail) console.log(`  [${jsRel}] ${err.detail}`);
            return sendJSON(res, err.status || 500, { error: err.message, detail: err.detail, logs: err.logs });
          }
        }
        const rel = `api/${fn[1]}.pyre`;
        if (req.method !== 'POST' || !isFile(rel)) throw new HttpError(404, 'function not found');
        const source = fs.readFileSync(inRoot(rel), 'utf8');
        const { meta } = compileAll(source, { filename: rel });
        if (meta.entry !== 'kernel') throw new HttpError(400, `${rel} has no @kernel`);
        const out = await runFunction(source, validateInput(await readJSON(req, 16 * 1024 * 1024), meta));
        return sendJSON(res, 200, { buffers: out.buffers, ms: out.ms });
      }
      if (serveTree(req, res, pathname, {})) return;

      const r = resolveSitePath(has, pathname, { cleanUrls: true, spa: false });
      if (r.redirect) { res.writeHead(308, { Location: r.redirect }); return res.end(); }
      if (!r.path) {
        return sendBuffer(req, res, 404, Buffer.from(`404: ${pathname} not found in ${root}\n`), 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store' });
      }
      const headers = { ...deploymentHeaders({ https: false }), 'Cache-Control': 'no-store' };
      const src = generated(r.path);
      let body;
      if (src && !isFile(r.path)) {
        const out = compileFile(src);
        body = r.path.endsWith('.json')
          ? JSON.stringify({ meta: out.meta, glsl: out.glsl || null, wgsl: out.wgsl || null })
          : out[r.path.endsWith('.glsl') ? 'glsl' : 'wgsl'];
        if (!body) throw new HttpError(404, `${src} has no ${path.extname(r.path)} output`);
        body = Buffer.from(body);
      } else {
        body = fs.readFileSync(inRoot(r.path));
      }
      if (isHtml(r.path)) {
        const html = body.toString('utf8');
        body = Buffer.from(html.includes('</body>') ? html.replace('</body>', `${CLIENT}</body>`) : html + CLIENT);
      }
      sendBuffer(req, res, r.status, body, mimeType(r.path), headers);
    } catch (err) {
      if (err instanceof PyreError) return sendBuffer(req, res, 500, Buffer.from(err.format()), 'text/plain; charset=utf-8', { 'Access-Control-Allow-Origin': '*' });
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (pathname.startsWith('/api/')) return sendJSON(res, status, { error: err.message }, { 'Access-Control-Allow-Origin': '*' });
      sendBuffer(req, res, status, Buffer.from(String(err.message)), 'text/plain; charset=utf-8', {});
    }
  }

  // live reload: check .pyre files compile before reloading
  const broadcast = (event, data = {}) => {
    for (const c of clients) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  let timer = null;
  const changed = new Set();
  const watcher = fs.watch(root, { recursive: true }, (_, file) => {
    if (!file || /(^|[/\\])(\.|node_modules)/.test(file)) return;
    changed.add(file.split(path.sep).join('/'));
    clearTimeout(timer);
    timer = setTimeout(() => {
      const files = [...changed];
      changed.clear();
      for (const f of files.filter((x) => x.endsWith('.pyre') && isFile(x))) {
        try {
          compileFile(f);
        } catch (err) {
          if (err instanceof PyreError) {
            if (log) console.log(`\n${err.format()}\n`);
            broadcast('pyre-error', { file: f, text: err.format() });
            return;
          }
        }
      }
      if (log) console.log(`  ↻ ${files.join(', ')}`);
      broadcast('reload');
    }, 80);
  });

  const server = http.createServer(handle);
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({
        url: `http://${host}:${addr.port}`,
        server,
        close: () => new Promise((r) => { watcher.close(); sql.close(); for (const c of clients) c.end(); server.close(r); server.closeAllConnections?.(); }),
      });
    });
  });
}

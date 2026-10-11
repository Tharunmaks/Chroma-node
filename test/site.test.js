import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot } from './helpers.js';

let srv;
before(async () => { srv = await boot(); });
after(async () => { await srv.stop(); });

test('every page is served with a strict CSP whose hash matches the inline import map', async () => {
  for (const p of ['/', '/playground', '/docs', '/dashboard', '/engine']) {
    const res = await fetch(srv.url + p);
    assert.equal(res.status, 200, p);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    const html = await res.text();
    assert.doesNotMatch(html, /<!--#(head|nav|footer)-->/, 'partials are expanded');
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      const hash = crypto.createHash('sha256').update(m[1]).digest('base64');
      assert.ok(csp.includes(`'sha256-${hash}'`), `${p}: inline script hash in CSP`);
    }
    for (const h of ['x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy']) {
      assert.ok(res.headers.get(h), `${p}: ${h}`);
    }
  }
});

test('libraries are served for the browser and for sandboxed deployments', async () => {
  for (const p of ['/vendor/three/three.module.js', '/vendor/three/addons/controls/OrbitControls.js', '/vendor/pyre/index.js', '/assets/js/helix/helix.js']) {
    const res = await fetch(srv.url + p, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  }
  const etag = (await fetch(`${srv.url}/assets/js/common.js`)).headers.get('etag');
  assert.equal((await fetch(`${srv.url}/assets/js/common.js`, { headers: { 'if-none-match': etag } })).status, 304);
});

test('the CPU worker is the only script allowed to eval, and it has no network access', async () => {
  const res = await fetch(`${srv.url}/assets/js/pyre-worker.js`);
  assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; script-src 'self' 'unsafe-eval'");
});

test('static file serving cannot escape its directories', async () => {
  for (const p of ['/assets/../server/app.js', '/assets/%2e%2e/%2e%2e/package.json', '/vendor/pyre/..%2f..%2f..%2fpackage.json', '/assets/..%5c..%5cpackage.json']) {
    const res = await fetch(srv.url + p);
    assert.equal(res.status, 404, p);
  }
});

test('API errors are JSON, unknown pages are HTML 404s, odd methods are refused', async () => {
  const api = await fetch(`${srv.url}/api/nope`);
  assert.equal(api.status, 404);
  assert.equal((await api.json()).error, 'no such API route');
  const page = await fetch(`${srv.url}/nope`);
  assert.equal(page.status, 404);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal((await fetch(`${srv.url}/`, { method: 'PATCH' })).status, 405);
  assert.equal((await fetch(`${srv.url}/api/projects`, { method: 'PUT' })).status, 405);
});

test('request bodies are size-limited and must be JSON objects', async () => {
  const big = await fetch(`${srv.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(2 * 1024 * 1024) }) });
  assert.equal(big.status, 413);
  const arr = await fetch(`${srv.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1,2]' });
  assert.equal(arr.status, 400);
});

test('every shader and kernel shipped with the site and templates compiles', async () => {
  const { compileAll } = await import('pyre-lang');
  const { SHADERS, KERNELS } = await import('../web/assets/js/shaders.js');
  for (const [name, s] of Object.entries({ ...SHADERS, ...KERNELS })) {
    const r = compileAll(s.source, { filename: name });
    assert.ok(r.meta.entry === 'fragment' ? r.glsl && r.wgsl : r.wgsl, name);
  }
  const fs = await import('node:fs');
  for (const f of ['templates/helix-starter/shaders/lava.pyre', 'templates/helix-starter/api/saxpy.pyre']) {
    assert.ok(compileAll(fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).meta.entry, f);
  }
});

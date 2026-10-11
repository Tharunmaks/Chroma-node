import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, file } from './helpers.js';

let srv;
let alice;
let bob;
before(async () => {
  srv = await boot();
  alice = new Client(srv.url);
  await alice.signup('alice', 'unique pass phrase 42');
  bob = new Client(srv.url);
  await bob.signup('bob', 'unique pass phrase 42');
});
after(async () => { await srv.stop(); });

const SHADER = 'uniform time: float\n@fragment\nfn main(uv: vec2) -> vec4:\n    return vec4(uv, sin(time), 1.0)\n';
const site = (extra = []) => [
  file('index.html', '<!doctype html><title>home</title><h1>home</h1>'),
  file('about.html', '<!doctype html><title>about</title>about page'),
  file('docs/index.html', 'docs index'),
  file('404.html', 'custom not found'),
  file('art/shader.pyre', SHADER),
  ...extra,
];

test('project names are validated, reserved, unique and owner-scoped', async () => {
  assert.equal((await alice.req('POST', '/api/projects', { name: 'Bad_Name' })).status, 400);
  assert.equal((await alice.req('POST', '/api/projects', { name: 'api' })).status, 400);
  assert.equal((await alice.req('POST', '/api/projects', { name: 'site' })).status, 201);
  assert.equal((await bob.req('POST', '/api/projects', { name: 'site' })).status, 409);
  // bob cannot see, deploy to or delete alice's project (and can't tell it exists)
  assert.equal((await bob.req('GET', '/api/projects/site')).status, 404);
  assert.equal((await bob.req('POST', '/api/projects/site/deployments', { files: site() })).status, 404);
  assert.equal((await bob.req('DELETE', '/api/projects/site')).status, 404);
  assert.equal((await bob.req('GET', '/api/projects')).data.projects.length, 0);
});

test('deploy builds Pyre files and serves the site with clean URLs', async () => {
  const r = await alice.req('POST', '/api/projects/site/deployments', { files: site() });
  assert.equal(r.status, 201);
  const d = r.data.deployment;
  assert.equal(d.status, 'READY');
  assert.ok(d.log.some((l) => l.file === 'art/shader.pyre' && /glsl, wgsl/.test(l.message)));
  const get = (p) => fetch(srv.url + p, { redirect: 'manual' });
  assert.match(await (await get('/p/site/')).text(), /home/);
  assert.match(await (await get('/p/site/about')).text(), /about page/);
  assert.equal((await get('/p/site/docs')).status, 308);
  assert.match(await (await get('/p/site/docs/')).text(), /docs index/);
  const missing = await get('/p/site/nope');
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /custom not found/);
  const glsl = await (await get('/p/site/art/shader.glsl')).text();
  assert.match(glsl, /#version 300 es/);
  const wgsl = await (await get('/p/site/art/shader.wgsl')).text();
  assert.match(wgsl, /@fragment/);
  const meta = await (await get('/p/site/art/shader.pyre.json')).json();
  assert.equal(meta.meta.entry, 'fragment');
  assert.equal((await get(`/d/${d.id}/about`)).status, 200);
});

test('deployed content is sandboxed: opaque-origin CSP on every file, nosniff, no cookies', async () => {
  for (const p of ['/p/site/', '/p/site/art/shader.glsl', '/p/site/nope']) {
    const res = await fetch(srv.url + p);
    assert.match(res.headers.get('content-security-policy'), /^sandbox allow-scripts/, p);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('set-cookie'), null);
  }
  // an uploaded SVG with a script must not run on the platform origin
  await alice.req('POST', '/api/projects/site/deployments', { files: site([file('x.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')]) });
  const svg = await fetch(`${srv.url}/p/site/x.svg`);
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
  assert.match(svg.headers.get('content-security-policy'), /sandbox/);
});

test('uploads reject traversal, absolute paths, hidden files and junk', async () => {
  const bad = ['../evil.html', '/etc/passwd', 'a/../../b', '.env', 'dir/.git/config', 'a\\b', 'a//b', 'x\u0000y', ''];
  for (const p of bad) {
    const r = await alice.req('POST', '/api/projects/site/deployments', { files: [{ path: p, data: '' }] });
    assert.equal(r.status, 400, JSON.stringify(p));
  }
  const notB64 = await alice.req('POST', '/api/projects/site/deployments', { files: [{ path: 'a.txt', data: '<script>' }] });
  assert.equal(notB64.status, 400);
  const dup = await alice.req('POST', '/api/projects/site/deployments', { files: [file('a.txt', '1'), file('a.txt', '2')] });
  assert.equal(dup.status, 400);
  const empty = await alice.req('POST', '/api/projects/site/deployments', { files: [] });
  assert.equal(empty.status, 400);
});

test('oversized uploads are refused', async () => {
  const big = 'A'.repeat(11 * 1024 * 1024);
  const r = await alice.req('POST', '/api/projects/site/deployments', { files: [{ path: 'big.bin', data: Buffer.from(big).toString('base64') }] });
  assert.equal(r.status, 413);
});

test('a failing Pyre build does not replace production', async () => {
  const before = (await alice.req('GET', '/api/projects/site')).data.project.production.id;
  const r = await alice.req('POST', '/api/projects/site/deployments', { files: site([file('broken.pyre', 'fn f() -> float:\n    return nope\n')]) });
  assert.equal(r.data.deployment.status, 'ERROR');
  assert.ok(r.data.deployment.log.some((l) => l.level === 'error' && /unknown name 'nope'/.test(l.message)));
  const after = (await alice.req('GET', '/api/projects/site')).data.project.production.id;
  assert.equal(after, before);
  assert.equal((await alice.req('POST', '/api/projects/site/promote', { deploymentId: r.data.deployment.id })).status, 409);
});

test('promote rolls production back; the live deployment cannot be deleted', async () => {
  const { data } = await alice.req('GET', '/api/projects/site');
  const ready = data.deployments.filter((d) => d.status === 'READY');
  const live = data.project.production.id;
  const older = ready.find((d) => d.id !== live);
  assert.equal((await alice.req('POST', '/api/projects/site/promote', { deploymentId: older.id })).status, 200);
  assert.equal((await alice.req('GET', '/api/projects/site')).data.project.production.id, older.id);
  assert.equal((await alice.req('DELETE', `/api/deployments/${older.id}`)).status, 409);
  assert.equal((await alice.req('DELETE', `/api/deployments/${live}`)).status, 200);
  assert.equal((await bob.req('GET', `/api/deployments/${older.id}`)).status, 404);
});

test('templates deploy in one call', async () => {
  await alice.req('POST', '/api/projects', { name: 'starter' });
  const r = await alice.req('POST', '/api/projects/starter/templates/helix-starter');
  assert.equal(r.status, 201);
  assert.equal(r.data.deployment.status, 'READY');
  assert.deepEqual(r.data.deployment.functions, ['saxpy']);
  assert.equal((await alice.req('POST', '/api/projects/starter/templates/..%2f..%2fetc')).status, 404);
});

test('deleting a project removes its deployments and unreferenced blobs', async () => {
  await alice.req('POST', '/api/projects', { name: 'temp' });
  await alice.req('POST', '/api/projects/temp/deployments', { files: [file('index.html', 'unique-content-for-gc-test')] });
  assert.equal((await fetch(`${srv.url}/p/temp/`)).status, 200);
  assert.equal((await alice.req('DELETE', '/api/projects/temp')).status, 200);
  assert.equal((await fetch(`${srv.url}/p/temp/`)).status, 404);
});

test('the full-stack template deploys with its database collection configured', async () => {
  await alice.req('POST', '/api/projects', { name: 'guest' });
  const r = await alice.req('POST', '/api/projects/guest/templates/fullstack');
  assert.equal(r.data.deployment.status, 'READY');
  assert.deepEqual(r.data.deployment.functions, ['stats']);
  const cols = (await alice.req('GET', '/api/projects/guest/db')).data.collections;
  assert.deepEqual(cols.map((c) => [c.name, c.read, c.write]), [['guestbook', 'public', 'create']]);
  const add = await fetch(`${srv.url}/api/db/guest/guestbook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"a","message":"b"}' });
  assert.equal(add.status, 201);
  assert.deepEqual(await (await fetch(`${srv.url}/api/fn/guest/stats`)).json(), { total: 1 });
});

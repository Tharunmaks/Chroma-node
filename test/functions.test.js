import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, file } from './helpers.js';

let srv;
before(async () => {
  srv = await boot();
  const c = new Client(srv.url);
  await c.signup('fnuser', 'function user password');
  await c.req('POST', '/api/projects', { name: 'fns' });
  const r = await c.req('POST', '/api/projects/fns/deployments', {
    files: [
      file('index.html', 'hi'),
      file('api/saxpy.pyre', 'uniform a: float\nbuffer x: [float]\nbuffer y: [float]\n@kernel\nfn saxpy(id: int):\n    y[id] = a * x[id] + y[id]\n'),
      file('api/math/spin.pyre', 'buffer b: [int]\n@kernel\nfn spin(id: int):\n    var i = 0\n    while i >= 0:\n        i = (i + 1) % 1000\n'),
    ],
  });
  assert.equal(r.data.deployment.status, 'READY');
});
after(async () => { await srv.stop(); });

const call = (name, body, headers = {}) => fetch(`${srv.url}/api/fn/fns/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('functions run kernels and return buffers', async () => {
  const res = await call('saxpy', { uniforms: { a: 2 }, buffers: { x: [1, 2, 3], y: [10, 10, 10] } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const data = await res.json();
  assert.deepEqual(data.buffers.y, [12, 14, 16]);
});

test('runaway kernels are stopped by the loop budget', async () => {
  const res = await call('math/spin', { buffers: { b: 1 } });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /loop budget/);
});

test('inputs are validated', async () => {
  assert.equal((await call('saxpy', { buffers: { x: 'nope' } })).status, 400);
  assert.equal((await call('saxpy', { buffers: { x: [1, null] } })).status, 400);
  assert.equal((await call('saxpy', { buffers: { x: 2_000_000 } })).status, 413);
  assert.equal((await call('saxpy', { count: -1 })).status, 400);
  assert.equal((await call('saxpy', { uniforms: { a: 'x' } })).status, 400);
  assert.equal((await call('missing', {})).status, 404);
  const bad = await fetch(`${srv.url}/api/fn/fns/saxpy`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(bad.status, 415);
});

test('CORS preflight is answered for sandboxed pages', async () => {
  const res = await fetch(`${srv.url}/api/fn/fns/saxpy`, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-methods'), /POST/);
});

test('public compile endpoint returns all targets or a positioned error', async () => {
  const ok = await fetch(`${srv.url}/api/compile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: '@fragment\nfn main(uv: vec2) -> vec4:\n    return vec4(uv, 0.0, 1.0)\n' }) });
  const data = await ok.json();
  assert.ok(data.glsl && data.wgsl && data.js);
  const bad = await fetch(`${srv.url}/api/compile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'fn f() -> float:\n    return 1.0 +\n' }) });
  assert.equal(bad.status, 422);
  assert.equal((await bad.json()).error.line, 2);
});

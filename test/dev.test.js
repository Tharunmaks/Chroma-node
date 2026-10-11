import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDevServer } from '../server/dev.js';

test('dev server: compiles Pyre on the fly, runs functions, reloads, stays in its folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chroma-dev-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><body>hello</body>');
  fs.writeFileSync(path.join(dir, 'fx.pyre'), '@fragment\nfn main(uv: vec2) -> vec4:\n    return vec4(uv, 0.0, 1.0)\n');
  fs.mkdirSync(path.join(dir, 'api'));
  fs.writeFileSync(path.join(dir, 'api', 'double.pyre'), 'buffer v: [float]\n@kernel\nfn double(id: int):\n    v[id] *= 2.0\n');
  const dev = await startDevServer({ dir, port: 0, log: false });
  try {
    const html = await (await fetch(dev.url + '/')).text();
    assert.match(html, /hello/);
    assert.match(html, /EventSource\('\/__chroma\/events'\)/, 'live reload client injected');
    assert.match(await (await fetch(dev.url + '/fx.glsl')).text(), /#version 300 es/);
    const fn = await fetch(dev.url + '/api/fn/dev/double', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ buffers: { v: [1, 2, 3] } }) });
    assert.deepEqual((await fn.json()).buffers.v, [2, 4, 6]);
    for (const p of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/hosts', '/.secret']) {
      assert.equal((await fetch(dev.url + p)).status, 404, p);
    }

    // live reload: a valid edit sends "reload", a broken shader sends "pyre-error"
    const ctrl = new AbortController();
    const res = await fetch(dev.url + '/__chroma/events', { signal: ctrl.signal });
    const reader = res.body.getReader();
    const events = [];
    const pump = (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ done: true }));
        if (done) return;
        for (const m of dec.decode(value).matchAll(/event: ([\w-]+)/g)) events.push(m[1]);
      }
    })();
    await new Promise((r) => setTimeout(r, 150));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><body>changed</body>');
    await new Promise((r) => setTimeout(r, 600));
    fs.writeFileSync(path.join(dir, 'fx.pyre'), 'fn broken(:\n');
    await new Promise((r) => setTimeout(r, 600));
    ctrl.abort();
    await pump;
    assert.ok(events.includes('reload'), `events: ${events}`);
    assert.ok(events.includes('pyre-error'), `events: ${events}`);
  } finally {
    await dev.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dev server: JS functions and an in-memory database work locally', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chroma-dev-'));
  fs.writeFileSync(path.join(dir, 'index.html'), 'hi');
  fs.mkdirSync(path.join(dir, 'api'));
  fs.writeFileSync(path.join(dir, 'api', 'count.js'), "export default async (req, { db }) => { await db.collection('hits').add({ at: 1 }); return { json: { total: (await db.collection('hits').list()).total } }; }");
  const dev = await startDevServer({ dir, port: 0, log: false });
  try {
    await fetch(`${dev.url}/api/fn/dev/count`);
    assert.deepEqual(await (await fetch(`${dev.url}/api/fn/dev/count`)).json(), { total: 2 });
    const add = await fetch(`${dev.url}/api/db/dev/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"x"}' });
    assert.equal(add.status, 201);
    assert.equal((await (await fetch(`${dev.url}/api/db/dev/notes`)).json()).total, 1);
  } finally {
    await dev.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

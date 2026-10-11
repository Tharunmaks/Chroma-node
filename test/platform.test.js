import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, file } from './helpers.js';

let srv;
let owner;
let other;
before(async () => {
  srv = await boot({ allowJsFunctions: true });
  owner = new Client(srv.url);
  await owner.signup('owner', 'unique pass phrase 42');
  other = new Client(srv.url);
  await other.signup('other', 'unique pass phrase 42');
  await owner.req('POST', '/api/projects', { name: 'myapp' });
  const r = await owner.req('POST', '/api/projects/myapp/deployments', {
    files: [
      file('index.html', '<!doctype html><title>app</title>hello'),
      file('api/hello.js', `export default async function (req, { db }) {
  if (req.method === 'POST') {
    const doc = await db.collection('visits').add({ who: req.body.name });
    return { status: 201, json: { saved: doc._id } };
  }
  const { total } = await db.collection('visits').list();
  return { json: { hello: req.query.name || 'world', visits: total }, headers: { 'x-powered-by': 'chroma', 'set-cookie': 'evil=1' } };
}`),
      file('api/escape.js', `export default async () => { const F = console.log.constructor; return F('return process')().pid; }`),
      file('api/spin.js', 'export default async () => { for (;;) {} }'),
      file('api/env.js', 'export default async () => ({ json: [typeof process, typeof require, typeof fetch, typeof globalThis.__send, typeof setTimeout] })'),
    ],
  });
  assert.equal(r.data.deployment.status, 'READY', JSON.stringify(r.data.deployment.log));
});
after(async () => { await srv.stop(); });

const json = (method, path, body, headers = {}) => fetch(srv.url + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, headers: r.headers, data: await r.json().catch(() => null) }));

test('analytics: page views, unique visitors, referrers, devices, functions and custom events', async () => {
  for (let i = 0; i < 3; i++) await fetch(`${srv.url}/p/myapp/`, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; Mobile)', referer: 'https://example.org/post' } });
  await fetch(`${srv.url}/p/myapp/`, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0)' } });
  await fetch(`${srv.url}/p/myapp/missing`);
  await json('POST', '/api/a/myapp/event', { name: 'signup' });
  await fetch(`${srv.url}/api/fn/myapp/hello?name=x`);
  const { data } = await owner.req('GET', '/api/projects/myapp/analytics?range=1h');
  assert.equal(data.totals.views, 5);
  assert.equal(data.totals.visitors, 3, 'iPhone, Windows and node fetch (bot excluded) → 2 humans + 1 for /missing (bot ua)');
  assert.deepEqual(data.referrers[0], { key: 'example.org', n: 3 });
  assert.ok(data.devices.some((d) => d.key === 'mobile' && d.n === 3));
  assert.equal(data.events[0].key, 'signup');
  assert.equal(data.functions[0].key, 'hello');
  assert.ok(data.totals.errors >= 1);
  assert.equal(data.series.length, 61);
  assert.equal((await other.req('GET', '/api/projects/myapp/analytics')).status, 404, 'only the owner sees analytics');
  assert.equal((await json('POST', '/api/a/myapp/event', { name: '<script>' })).status, 400);
});

test('analytics stream pushes hits live', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${srv.url}/api/projects/myapp/analytics/stream`, { headers: { cookie: owner.cookie }, signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body.getReader();
  let text = '';
  const reading = (async () => { for (;;) { const { value, done } = await reader.read().catch(() => ({ done: true })); if (done) return; text += new TextDecoder().decode(value); } })();
  await new Promise((r) => setTimeout(r, 100));
  await fetch(`${srv.url}/p/myapp/`);
  await new Promise((r) => setTimeout(r, 200));
  ctrl.abort();
  await reading;
  assert.match(text, /event: live/);
  assert.match(text, /event: hit\ndata: \{"kind":"page","path":"\/"/);
});

test('database: rules decide what deployed pages may do', async () => {
  assert.equal((await owner.req('POST', '/api/projects/myapp/db', { name: 'guestbook', read: 'public', write: 'create' })).status, 201);
  assert.equal((await owner.req('POST', '/api/projects/myapp/db', { name: 'secrets' })).status, 201);
  const a = await json('POST', '/api/db/myapp/guestbook', { name: 'Ada', stars: 5 });
  assert.equal(a.status, 201);
  assert.equal(a.headers.get('access-control-allow-origin'), '*');
  await json('POST', '/api/db/myapp/guestbook', { name: 'Bob', stars: 2 });
  const list = await json('GET', '/api/db/myapp/guestbook?where=stars:gte:3');
  assert.deepEqual(list.data.docs.map((d) => d.name), ['Ada']);
  assert.equal((await json('GET', '/api/db/myapp/guestbook?order=stars')).data.docs[0].name, 'Bob');
  assert.equal((await json('PUT', `/api/db/myapp/guestbook/${a.data.doc._id}`, { name: 'Hacked' })).status, 403, "'create' rule forbids edits");
  assert.equal((await json('DELETE', `/api/db/myapp/guestbook/${a.data.doc._id}`)).status, 403);
  assert.equal((await json('GET', '/api/db/myapp/secrets')).status, 403, 'private collections are not public');
  assert.equal((await json('POST', '/api/db/myapp/secrets', { x: 1 })).status, 403);
  // the owner's API token bypasses rules
  const { data } = await owner.req('POST', '/api/tokens', { name: 'server' });
  assert.equal((await json('POST', '/api/db/myapp/secrets', { key: 'v' }, { authorization: `Bearer ${data.token}` })).status, 201);
  const otherTok = (await other.req('POST', '/api/tokens', { name: 'x' })).data.token;
  assert.equal((await json('GET', '/api/db/myapp/secrets', undefined, { authorization: `Bearer ${otherTok}` })).status, 403);
  // validation
  assert.equal((await json('POST', '/api/db/myapp/guestbook', { big: 'x'.repeat(20000) })).status, 413);
  assert.equal((await json('POST', '/api/db/myapp/guestbook', { __proto__: { polluted: 1 }, constructor: 1 })).status, 400);
  assert.equal((await json('GET', "/api/db/myapp/guestbook?where=stars');drop table docs;--:eq:1")).status, 400);
  assert.equal((await json('GET', '/api/db/myapp/guestbook?order=1;drop')).status, 400);
  assert.equal((await json('GET', '/api/db/nope/guestbook')).status, 404);
  // owner view
  const cols = (await owner.req('GET', '/api/projects/myapp/db')).data.collections;
  assert.deepEqual(cols.map((c) => [c.name, c.count]), [['guestbook', 2], ['secrets', 1]]);
  assert.equal((await other.req('GET', '/api/projects/myapp/db')).status, 404);
});

test('database: realtime stream delivers adds to subscribers', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${srv.url}/api/db/myapp/guestbook/stream`, { signal: ctrl.signal });
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const reader = res.body.getReader();
  let text = '';
  const reading = (async () => { for (;;) { const { value, done } = await reader.read().catch(() => ({ done: true })); if (done) return; text += new TextDecoder().decode(value); } })();
  await new Promise((r) => setTimeout(r, 100));
  await json('POST', '/api/db/myapp/guestbook', { name: 'Live' });
  await new Promise((r) => setTimeout(r, 150));
  ctrl.abort();
  await reading;
  assert.match(text, /event: add\ndata: .*"name":"Live"/);
  assert.equal((await fetch(`${srv.url}/api/db/myapp/secrets/stream`)).status, 403);
});

test('JS server functions: run, use the database, and cannot set security headers', async () => {
  const post = await json('POST', '/api/fn/myapp/hello', { name: 'Ada' });
  assert.equal(post.status, 201);
  assert.ok(post.data.saved);
  const res = await fetch(`${srv.url}/api/fn/myapp/hello?name=Bob`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { hello: 'Bob', visits: 1 });
  assert.equal(res.headers.get('x-powered-by'), 'chroma');
  assert.equal(res.headers.get('set-cookie'), null);
});

test('JS server functions are sandboxed', async () => {
  const esc = await json('GET', '/api/fn/myapp/escape');
  assert.equal(esc.status, 500);
  assert.match(esc.data.detail, /Code generation from strings disallowed/);
  assert.deepEqual((await json('GET', '/api/fn/myapp/env')).data, ['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
  const t0 = Date.now();
  assert.equal((await json('GET', '/api/fn/myapp/spin')).status, 504);
  assert.ok(Date.now() - t0 < 8000);
});

test('JS server functions can be disabled per server and bad code fails the build', async () => {
  const off = await boot({ allowJsFunctions: false });
  try {
    const c = new Client(off.url);
    await c.signup('someone', 'unique pass phrase 42');
    await c.req('POST', '/api/projects', { name: 'x' });
    await c.req('POST', '/api/projects/x/deployments', { files: [file('index.html', 'x'), file('api/a.js', 'export default () => 1')] });
    assert.equal((await fetch(`${off.url}/api/fn/x/a`)).status, 501);
    const bad = await c.req('POST', '/api/projects/x/deployments', { files: [file('index.html', 'x'), file('api/b.js', 'export default (')] });
    assert.equal(bad.data.deployment.status, 'ERROR');
  } finally {
    await off.stop();
  }
});

test('saved models: private by default, public in the gallery, owner-only edits', async () => {
  const mine = await owner.req('POST', '/api/models', { name: 'Knot 3-7', family: 'knot', params: { p: 3, q: 7, tube: 0.2, radial: 8 } });
  assert.equal(mine.status, 201);
  const id = mine.data.model.id;
  assert.equal((await other.req('GET', `/api/models/${id}`)).status, 404);
  assert.equal((await owner.req('PUT', `/api/models/${id}`, { public: true })).status, 200);
  const g = await json('GET', '/api/models/gallery');
  assert.equal(g.data.models[0].author, 'owner');
  assert.equal((await other.req('GET', `/api/models/${id}`)).data.model.name, 'Knot 3-7');
  assert.equal((await other.req('DELETE', `/api/models/${id}`)).status, 404);
  assert.equal((await owner.req('POST', '/api/models', { name: 'x', family: 'nope', params: {} })).status, 400);
  assert.equal((await owner.req('POST', '/api/models', { name: 'x', family: 'knot', params: { p: 'a'.repeat(100) } })).status, 400);
  const pyre = await owner.req('POST', '/api/models', { name: 'Wave', family: 'pyre', params: {}, source: 'fn surface(u: float, v: float) -> vec3:\n    return vec3(u, sin(u * 6.0) * 0.2, v)\n' });
  assert.equal(pyre.status, 201);
  assert.equal((await owner.req('GET', '/api/models')).data.models.length, 2);
});

test('deleting a project removes its analytics and database', async () => {
  await owner.req('POST', '/api/projects', { name: 'gone' });
  await owner.req('POST', '/api/projects/gone/deployments', { files: [file('index.html', 'x')] });
  await owner.req('POST', '/api/projects/gone/db', { name: 'c', read: 'public', write: 'public' });
  await json('POST', '/api/db/gone/c', { a: 1 });
  await fetch(`${srv.url}/p/gone/`);
  const p = srv.app.deploys.project('gone');
  await owner.req('DELETE', '/api/projects/gone');
  srv.app.analytics.flush();
  assert.equal(srv.app.analytics.summary(p.id, '1h').totals.requests, 0);
  assert.deepEqual(srv.app.pdb.collections(p.id), []);
});

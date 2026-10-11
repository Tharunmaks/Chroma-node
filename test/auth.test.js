import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, Client } from './helpers.js';

let srv;
before(async () => { srv = await boot(); });
after(async () => { await srv.stop(); });

test('signup validates usernames and rejects weak passwords', async () => {
  const c = new Client(srv.url);
  assert.equal((await c.signup('ab')).status, 400);
  assert.equal((await c.signup('bad name!')).status, 400);
  assert.equal((await c.signup('alice', 'short')).status, 400);
  assert.equal((await c.signup('alice', 'password123')).status, 400);
  assert.equal((await c.signup('alice', 'alice-is-great-123')).status, 400, 'password containing the username');
  const ok = await c.signup('Alice', 'correct horse battery');
  assert.equal(ok.status, 201);
  assert.equal(ok.data.user.username, 'alice');
  assert.equal((await new Client(srv.url).signup('alice', 'another good pass')).status, 409);
});

test('session cookie is HttpOnly + SameSite=Strict and passwords are scrypt-hashed', async () => {
  const c = new Client(srv.url);
  const r = await c.signup('bob', 'unique pass phrase 42');
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  srv.app.store.flush();
  const db = fs.readFileSync(path.join(srv.dataDir, 'db.json'), 'utf8');
  assert.doesNotMatch(db, /bobs secret phrase/);
  assert.match(db, /scrypt\$32768\$8\$1\$/);
  // the raw session token is never stored, only its hash
  assert.ok(!db.includes(c.cookie.split('=')[1]));
  const st = fs.statSync(path.join(srv.dataDir, 'db.json'));
  assert.equal(st.mode & 0o777, 0o600);
});

test('login works, wrong passwords fail the same way as unknown users, and accounts lock', async () => {
  const c = new Client(srv.url);
  await c.signup('carol', 'unique pass phrase 42');
  const fresh = new Client(srv.url);
  assert.equal((await fresh.req('POST', '/api/auth/login', { username: 'carol', password: 'unique pass phrase 42' })).status, 200);
  const unknown = await fresh.req('POST', '/api/auth/login', { username: 'nobody-here', password: 'whatever-123' });
  const wrong = await fresh.req('POST', '/api/auth/login', { username: 'carol', password: 'wrong-password-1' });
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.data.error, wrong.data.error);
  for (let i = 0; i < 4; i++) await fresh.req('POST', '/api/auth/login', { username: 'carol', password: 'wrong-password-1' });
  const locked = await fresh.req('POST', '/api/auth/login', { username: 'carol', password: 'unique pass phrase 42' });
  assert.equal(locked.status, 429);
  assert.match(locked.data.error, /locked/);
});

test('CSRF: cookie-authenticated writes need the per-session token', async () => {
  const c = new Client(srv.url);
  await c.signup('dave', 'unique pass phrase 42');
  const noToken = await c.req('POST', '/api/projects', { name: 'csrf-test' }, { 'x-csrf-token': '' });
  assert.equal(noToken.status, 403);
  const badToken = await c.req('POST', '/api/projects', { name: 'csrf-test' }, { 'x-csrf-token': 'nope' });
  assert.equal(badToken.status, 403);
  const ok = await c.req('POST', '/api/projects', { name: 'csrf-test' });
  assert.equal(ok.status, 201);
});

test('cross-origin login and signup are rejected', async () => {
  const evil = new Client(srv.url, 'https://evil.example');
  assert.equal((await evil.signup('mallory', 'mallory password 1')).status, 403);
  assert.equal((await evil.req('POST', '/api/auth/login', { username: 'alice', password: 'correct horse battery' })).status, 403);
});

test('API tokens: created once, stored hashed, usable as Bearer, revocable', async () => {
  const c = new Client(srv.url);
  await c.signup('erin', 'unique pass phrase 42');
  const t = await c.req('POST', '/api/tokens', { name: 'ci' });
  assert.equal(t.status, 201);
  assert.match(t.data.token, /^chr_[A-Za-z0-9_-]{40,}$/);
  srv.app.store.flush();
  assert.ok(!fs.readFileSync(path.join(srv.dataDir, 'db.json'), 'utf8').includes(t.data.token));
  const bearer = new Client(srv.url);
  bearer.token = t.data.token;
  assert.equal((await bearer.req('POST', '/api/projects', { name: 'from-ci' })).status, 201, 'bearer needs no CSRF token');
  const list = await c.req('GET', '/api/tokens');
  assert.equal(list.data.tokens[0].prefix, t.data.token.slice(0, 8));
  assert.equal(list.data.tokens[0].hash, undefined);
  assert.equal((await c.req('DELETE', `/api/tokens/${t.data.id}`)).status, 200);
  assert.equal((await bearer.req('GET', '/api/projects')).status, 401);
});

test('changing the password signs out other sessions', async () => {
  const a = new Client(srv.url);
  await a.signup('frank', 'unique pass phrase 42');
  const b = new Client(srv.url);
  await b.req('POST', '/api/auth/login', { username: 'frank', password: 'unique pass phrase 42' });
  assert.equal((await b.req('GET', '/api/projects')).status, 200);
  assert.equal((await a.req('POST', '/api/auth/password', { current: 'unique pass phrase 42', next: 'another pass phrase 7' })).status, 200);
  assert.equal((await b.req('GET', '/api/projects')).status, 401);
  assert.equal((await a.req('GET', '/api/projects')).status, 200);
});

test('audit log records security events per user', async () => {
  const c = new Client(srv.url);
  await c.signup('gina', 'unique pass phrase 42');
  await c.req('POST', '/api/projects', { name: 'gina-site' });
  const { data } = await c.req('GET', '/api/audit');
  const events = data.events.map((e) => e.event);
  assert.ok(events.includes('user.signup'));
  assert.ok(events.includes('project.created'));
});

test('auth endpoints are rate limited per IP', async () => {
  const strict = await boot({ rateLimits: { auth: 3 } });
  try {
    const c = new Client(strict.url);
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await c.req('POST', '/api/auth/login', { username: 'x-user', password: 'y-password-1' })).status);
    assert.deepEqual(codes.slice(3), [429, 429]);
  } finally {
    await strict.stop();
  }
});

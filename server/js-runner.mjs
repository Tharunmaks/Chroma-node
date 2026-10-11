// Child process that runs one JS server function. Launched by js-functions.js
// with Node's permission model (no filesystem, child processes, workers or
// native addons), --disallow-code-generation-from-strings, and a small heap.
//
// User code runs in a separate V8 context. The only thing it can reach is a
// bridge compiled *inside* that context; the bridge talks to this process
// with JSON strings, so no host object (and no host Function constructor)
// ever becomes reachable from user code.
import vm from 'node:vm';

// defence in depth: nothing below should be reachable anyway
for (const k of ['getBuiltinModule', 'binding', '_linkedBinding', 'dlopen']) {
  try { process[k] = undefined; } catch { /* ignore */ }
}

const BRIDGE = `
'use strict';
(() => {
  const send = globalThis.__send;
  delete globalThis.__send;
  const pending = new Map();
  let seq = 0;
  globalThis.__receive = (id, ok, payload) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(payload === undefined ? undefined : JSON.parse(payload));
    else p.reject(new Error(payload));
  };
  const call = (op, args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    send(id, op, JSON.stringify(args));
  });
  const collection = (name) => Object.freeze({
    list: (query = {}) => call('list', [name, query]),
    get: (id) => call('get', [name, id]),
    add: (doc) => call('add', [name, doc]),
    set: (id, doc) => call('set', [name, id, doc]),
    update: (id, doc) => call('update', [name, id, doc]),
    remove: (id) => call('remove', [name, id]),
  });
  const fmt = (args) => args.map((a) => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); } }).join(' ');
  globalThis.console = Object.freeze({
    log: (...a) => send(0, 'log', JSON.stringify(fmt(a))),
    info: (...a) => send(0, 'log', JSON.stringify(fmt(a))),
    warn: (...a) => send(0, 'log', JSON.stringify('warn: ' + fmt(a))),
    error: (...a) => send(0, 'log', JSON.stringify('error: ' + fmt(a))),
  });
  globalThis.__ctx = Object.freeze({ db: Object.freeze({ collection }) });
})();
`;

process.once('message', async ({ code, request }) => {
  const logs = [];
  const sandbox = Object.create(null);
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false }, name: 'chroma-function' });
  let receive = null;
  const replies = new Map();
  // host side of the bridge: only strings in, only strings out
  sandbox.__send = (id, op, json) => {
    if (op === 'log') { if (logs.length < 200) logs.push(String(JSON.parse(json)).slice(0, 2000)); return; }
    process.send({ type: 'db', id, op, args: json });
  };
  vm.runInContext(BRIDGE, context, { timeout: 1000 });
  receive = vm.runInContext('globalThis.__receive', context);
  vm.runInContext('delete globalThis.__receive;', context);
  process.on('message', (msg) => {
    if (msg.type === 'db-reply') receive(msg.id, msg.ok, msg.payload);
  });

  try {
    const wrapped = `'use strict';\n${String(code).replace(/^\s*export\s+default\s+/m, 'globalThis.__handler = ')}\n;globalThis.__handler;`;
    const handler = new vm.Script(wrapped, { filename: request.file }).runInContext(context, { timeout: 1000 });
    if (typeof handler !== 'function') throw new Error('the file must `export default` a function (request, { db }) => response');
    vm.runInContext('globalThis.__req = null', context);
    const reqJson = JSON.stringify(request);
    const run = vm.runInContext(`(async (h, req, ctx) => {
      const res = await h(JSON.parse(req), ctx);
      return JSON.stringify(res === undefined ? null : res);
    })`, context);
    const out = await run(handler, reqJson, vm.runInContext('globalThis.__ctx', context));
    process.send({ type: 'done', ok: true, response: out, logs });
  } catch (err) {
    process.send({ type: 'done', ok: false, error: String(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : err), logs });
  }
});

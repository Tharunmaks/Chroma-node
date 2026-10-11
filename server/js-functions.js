// JS server functions: `api/*.js` files in a deployment that export a
// request handler. Each request runs in a fresh, locked-down child process
// (see js-runner.mjs). On by default; disable with ALLOW_JS_FUNCTIONS=0.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { HttpError } from './http.js';

const RUNNER = fileURLToPath(new URL('./js-runner.mjs', import.meta.url));
export const JS_LIMITS = { timeoutMs: 5000, memoryMb: 64, responseBytes: 1024 * 1024, dbCalls: 200 };

/** Syntax check at build time (never executes the code). */
export function checkJsFunction(code, filename) {
  try {
    new vm.Script(`(async () => {\n${String(code).replace(/^\s*export\s+default\s+/m, 'globalThis.__handler = ')}\n})`, { filename });
    if (!/^\s*export\s+default\s+/m.test(code)) return 'missing `export default` handler';
    return null;
  } catch (err) {
    return err.message;
  }
}

/**
 * Run a handler. `db(op, args)` performs database operations for the
 * function's own project and returns a JSON-serialisable result.
 */
export function runJsFunction(code, request, { db }) {
  return new Promise((resolve, reject) => {
    const child = fork(RUNNER, [], {
      execArgv: [
        '--permission',
        `--allow-fs-read=${RUNNER}`,
        '--disallow-code-generation-from-strings',
        `--max-old-space-size=${JS_LIMITS.memoryMb}`,
        '--stack-size=900',
      ],
      env: {},
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'json',
    });
    let done = false;
    let calls = 0;
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); child.kill('SIGKILL'); fn(); };
    const timer = setTimeout(() => finish(() => reject(new HttpError(504, `function exceeded ${JS_LIMITS.timeoutMs} ms`))), JS_LIMITS.timeoutMs);
    child.on('message', async (msg) => {
      if (msg.type === 'db') {
        let reply;
        try {
          if (++calls > JS_LIMITS.dbCalls) throw new Error(`more than ${JS_LIMITS.dbCalls} database calls`);
          const result = await db(msg.op, JSON.parse(msg.args));
          reply = { type: 'db-reply', id: msg.id, ok: true, payload: result === undefined ? undefined : JSON.stringify(result) };
        } catch (err) {
          reply = { type: 'db-reply', id: msg.id, ok: false, payload: String(err.message || err) };
        }
        if (!done) child.send(reply);
        return;
      }
      if (msg.type === 'done') {
        finish(() => {
          if (!msg.ok) return reject(Object.assign(new HttpError(500, 'function threw an error'), { detail: msg.error, logs: msg.logs }));
          if (msg.response && msg.response.length > JS_LIMITS.responseBytes) return reject(new HttpError(500, 'function response is larger than 1 MB'));
          resolve({ response: JSON.parse(msg.response || 'null'), logs: msg.logs });
        });
      }
    });
    child.on('exit', (code, signal) => finish(() => reject(new HttpError(500, `function crashed (out of memory or exit code ${code ?? signal})`))));
    child.on('error', () => finish(() => reject(new HttpError(500, 'could not start the function runtime'))));
    child.send({ code, request });
  });
}

/** Turn a handler's return value into status, headers and body. */
export function toHttp(result) {
  if (result === null || result === undefined) return { status: 204, headers: {}, body: '' };
  if (typeof result !== 'object' || Array.isArray(result) || !('status' in result || 'json' in result || 'body' in result)) {
    return { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(result) };
  }
  const status = Number.isInteger(result.status) && result.status >= 100 && result.status <= 599 ? result.status : 200;
  const headers = {};
  for (const [k, v] of Object.entries(result.headers || {})) {
    // functions may set ordinary headers, never security or cookie headers
    if (/^[a-z0-9-]{1,64}$/i.test(k) && !/^(set-cookie|content-security-policy|access-control-|strict-transport|content-length|transfer-encoding|connection)/i.test(k)) headers[k] = String(v).slice(0, 1024).replace(/[\r\n]/g, '');
  }
  if ('json' in result) return { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(result.json) };
  return { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers }, body: String(result.body ?? '') };
}

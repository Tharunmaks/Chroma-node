// Pyre Functions: HTTP-invoked @kernel programs, executed on the CPU in a
// fresh worker thread per request with strict input, time and memory limits.
import { Worker } from 'node:worker_threads';
import { HttpError } from './http.js';

export const FN_LIMITS = { maxElements: 1_000_000, maxCount: 1_000_000, timeoutMs: 3000, loopLimit: 20_000_000, memoryMb: 96 };

function numbers(value, name) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new HttpError(400, `${name} must be finite`);
    return value;
  }
  if (Array.isArray(value) && value.length <= 16 && value.every((n) => typeof n === 'number' && Number.isFinite(n))) return value;
  throw new HttpError(400, `${name} must be a number or a short array of numbers`);
}

export function validateInput(body, meta) {
  const uniforms = {};
  const given = body.uniforms && typeof body.uniforms === 'object' ? body.uniforms : {};
  for (const u of meta.uniforms) if (Object.hasOwn(given, u.name)) uniforms[u.name] = numbers(given[u.name], `uniform ${u.name}`);
  const buffers = {};
  let total = 0;
  const gb = body.buffers && typeof body.buffers === 'object' ? body.buffers : {};
  for (const b of meta.buffers) {
    if (!Object.hasOwn(gb, b.name)) continue;
    const v = gb[b.name];
    if (Number.isInteger(v) && v >= 0) {
      total += v;
      buffers[b.name] = v;
    } else if (Array.isArray(v)) {
      if (!v.every((n) => typeof n === 'number' && Number.isFinite(n))) throw new HttpError(400, `buffer ${b.name} must contain only finite numbers`);
      total += v.length;
      buffers[b.name] = v;
    } else throw new HttpError(400, `buffer ${b.name} must be an array of numbers or a length`);
    if (total > FN_LIMITS.maxElements) throw new HttpError(413, `buffers may hold at most ${FN_LIMITS.maxElements} elements in total`);
  }
  let count;
  if (body.count !== undefined) {
    if (!Number.isInteger(body.count) || body.count < 0 || body.count > FN_LIMITS.maxCount) throw new HttpError(400, `count must be a whole number up to ${FN_LIMITS.maxCount}`);
    count = body.count;
  }
  return { uniforms, buffers, count };
}

export function runFunction(source, input) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./fn-worker.js', import.meta.url), {
      workerData: { source, ...input, loopLimit: FN_LIMITS.loopLimit },
      resourceLimits: { maxOldGenerationSizeMb: FN_LIMITS.memoryMb, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new HttpError(504, `function exceeded ${FN_LIMITS.timeoutMs} ms`));
    }, FN_LIMITS.timeoutMs);
    worker.once('message', (msg) => {
      clearTimeout(timer);
      worker.terminate();
      if (msg.ok) resolve(msg);
      else reject(new HttpError(422, msg.error));
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      reject(new HttpError(500, err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'function ran out of memory' : 'function crashed'));
    });
  });
}

// Runs one Pyre kernel in an isolated worker thread. The parent enforces a
// wall-clock timeout and memory limit; Pyre itself enforces a loop budget.
import { parentPort, workerData } from 'node:worker_threads';
import { runKernel } from 'pyre-lang';

try {
  const { source, uniforms, buffers, count, loopLimit } = workerData;
  const started = performance.now();
  const out = runKernel(source, { uniforms, buffers, count, loopLimit });
  const result = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Array.from(v)]));
  parentPort.postMessage({ ok: true, buffers: result, ms: +(performance.now() - started).toFixed(2) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.format ? err.format() : String(err.message || err) });
}

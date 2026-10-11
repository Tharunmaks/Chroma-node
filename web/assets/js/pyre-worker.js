// Runs Pyre programs on the CPU off the main thread. This worker is served
// with its own CSP (script-src 'self' 'unsafe-eval', no network), so the
// page itself keeps a strict no-eval policy while generated code runs here,
// isolated from the DOM, cookies and the network.
import { createProgram } from '/vendor/pyre/index.js';

const programs = new Map();
const plain = (buffers) => Object.fromEntries(Object.entries(buffers).map(([k, v]) => [k, Array.from(v)]));

self.onmessage = ({ data }) => {
  const { id, op } = data;
  try {
    if (op === 'run') {
      const t0 = performance.now();
      const prog = createProgram(data.source, { uniforms: data.uniforms, buffers: data.buffers, loopLimit: 20_000_000 });
      prog.run(data.count);
      self.postMessage({ id, ok: true, buffers: plain(prog.buffers), ms: performance.now() - t0 });
    } else if (op === 'init') {
      programs.set(data.key, createProgram(data.source, { uniforms: data.uniforms, buffers: data.buffers, loopLimit: 20_000_000 }));
      self.postMessage({ id, ok: true });
    } else if (op === 'step') {
      const prog = programs.get(data.key);
      if (!prog) throw new Error('unknown program');
      prog.run(data.count);
      self.postMessage({ id, ok: true, buffers: plain(prog.buffers) });
    } else if (op === 'drop') {
      programs.delete(data.key);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.format ? err.format() : String(err.message || err) });
  }
};

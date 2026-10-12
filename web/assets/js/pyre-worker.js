// Runs Pyre programs on the CPU off the main thread. This worker is served
// with its own CSP (script-src 'self' 'unsafe-eval', no network), so the
// page itself keeps a strict no-eval policy while generated code runs here,
// isolated from the DOM, cookies and the network.
import { createProgram } from '../../vendor/pyre/index.js';

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
    } else if (op === 'surface') {
      // Pyre-defined model: fn surface(u: float, v: float) -> vec3 (or surface4 -> vec4)
      const t0 = performance.now();
      const prog = createProgram(data.source, { loopLimit: 50_000_000, uniforms: data.uniforms || {} });
      const f3 = prog.functions.surface;
      const f4 = prog.functions.surface4;
      if (!f3 && !f4) throw new Error('define fn surface(u: float, v: float) -> vec3 (or surface4(u, v) -> vec4 for a 4D model)');
      const n = Math.min(400, Math.max(4, data.segments || 128));
      const m = Math.min(400, Math.max(4, data.segments2 || n));
      const dims = f4 ? 4 : 3;
      const fn = f4 || f3;
      const out = new Float32Array((n + 1) * (m + 1) * dims);
      let k = 0;
      for (let j = 0; j <= m; j++) for (let i = 0; i <= n; i++) {
        const p = fn(i / n, j / m);
        if (!Array.isArray(p) || p.length !== dims) throw new Error(`surface must return a vec${dims}`);
        for (let d = 0; d < dims; d++) out[k++] = Number.isFinite(p[d]) ? p[d] : 0;
      }
      self.postMessage({ id, ok: true, dims, segments: n, segments2: m, positions: out, ms: performance.now() - t0 }, [out.buffer]);
    } else if (op === 'drop') {
      programs.delete(data.key);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.format ? err.format() : String(err.message || err) });
  }
};

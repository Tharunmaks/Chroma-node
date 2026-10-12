// Notebook kernel for Pyre Torch. Runs cells off the main thread; served
// with a CSP that allows evaluating code but no network access, so a
// notebook can compute anything and exfiltrate nothing.
import torch from '../../vendor/pyre/torch/index.js';

const fmt = (v) => {
  if (v instanceof torch.Tensor) return String(v);
  if (typeof v === 'function' && v.forward) return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x === 'number')) return `[${v.map((x) => +x.toFixed(6)).join(', ')}]`;
  if (typeof v === 'object' && v !== null) { try { return JSON.stringify(v, (k, x) => (typeof x === 'number' ? +x.toFixed(6) : x), 2); } catch { return String(v); } }
  return String(v);
};
const toArray = (v) => (v instanceof torch.Tensor ? Array.from(v.data) : Array.from(v));

let current = 0;
const send = (msg) => self.postMessage({ cell: current, ...msg });
const helpers = {
  torch,
  print: (...a) => send({ type: 'out', text: a.map(fmt).join(' ') }),
  /** plot('loss', values) — draws or updates a named line chart. Multiple series: plot('acc', { train: [...], test: [...] }) */
  plot(name, values) {
    const series = Array.isArray(values) || values instanceof torch.Tensor || ArrayBuffer.isView(values)
      ? [{ name, values: toArray(values) }]
      : Object.entries(values).map(([k, v]) => ({ name: k, values: toArray(v) }));
    send({ type: 'plot', name, series });
  },
  /** boundary(model, X, Y): decision regions of a 2D classifier with its training points. */
  boundary(model, X, Y, { steps = 70, name = 'decision boundary' } = {}) {
    const xs = toArray(X.narrow(1, 0, 1));
    const ys = toArray(X.narrow(1, 1, 1));
    const pad = 0.15;
    const b = [Math.min(...xs) - pad, Math.max(...xs) + pad, Math.min(...ys) - pad, Math.max(...ys) + pad];
    const pts = [];
    for (let j = 0; j < steps; j++) for (let i = 0; i < steps; i++) pts.push([b[0] + ((i + 0.5) / steps) * (b[1] - b[0]), b[2] + ((j + 0.5) / steps) * (b[3] - b[2])]);
    const pred = torch.noGrad(() => model(torch.tensor(pts)));
    const cls = pred.shape[1] === 1 ? pred.data.map((v) => (v > 0 ? 1 : 0)) : pred.argmax(1).data;
    send({ type: 'region', name, grid: Array.from(cls), gx: steps, gy: steps, bounds: b, points: xs.map((x, i) => [x, ys[i], Y.data[i]]) });
  },
  datasets: {
    spirals: (n = 150, classes = 2) => { const d = torch.data.spirals(n, { classes }); return [torch.tensor(d.x), torch.tensor(d.y)]; },
    moons(n = 200, noise = 0.12) {
      const x = []; const y = [];
      for (let i = 0; i < n; i++) {
        const t = Math.PI * (i / n);
        const c = i % 2;
        x.push(c ? [1 - Math.cos(t), 0.5 - Math.sin(t)] : [Math.cos(t), Math.sin(t)]);
        x[i][0] += (Math.random() - 0.5) * noise * 2; x[i][1] += (Math.random() - 0.5) * noise * 2;
        y.push(c);
      }
      return [torch.tensor(x), torch.tensor(y)];
    },
    blobs(n = 300, k = 3) {
      const x = []; const y = [];
      for (let i = 0; i < n; i++) { const c = i % k; const a = (c / k) * Math.PI * 2; x.push([Math.cos(a) * 2 + torch.randn(1).item() * 0.5, Math.sin(a) * 2 + torch.randn(1).item() * 0.5]); y.push(c); }
      return [torch.tensor(x), torch.tensor(y)];
    },
    sine(n = 128) { const x = torch.linspace(-Math.PI, Math.PI, n).reshape(-1, 1); return [x, x.sin()]; },
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

// Top-level `const x = ...` in a cell becomes a notebook variable (global),
// so later cells can use it — like Python notebooks.
function hoist(code) {
  return code.split('\n').map((line) => line
    .replace(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, '$1 =')
    .replace(/^(?:const|let|var)\s+(\{[^}]*\}|\[[^\]]*\])\s*=\s*(.+?);?\s*$/, '($1 = $2);')
    .replace(/^(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/, (m, a, name) => `${name} = ${a || ''}function ${name}(`)
    .replace(/^class\s+([A-Za-z_$][\w$]*)/, '$1 = class $1')).join('\n');
}

const AsyncFunction = (async () => {}).constructor;
self.onmessage = async ({ data }) => {
  if (data.op !== 'run') return;
  current = data.cell;
  const t0 = performance.now();
  try {
    const fn = new AsyncFunction(...Object.keys(helpers), hoist(data.code));
    await fn(...Object.values(helpers));
    send({ type: 'done', ms: performance.now() - t0 });
  } catch (err) {
    const where = /<anonymous>:(\d+):(\d+)/.exec(err.stack || '');
    send({ type: 'error', text: `${err.name}: ${err.message}${where ? ` (line ${Number(where[1]) - 2})` : ''}`, ms: performance.now() - t0 });
  }
};

// Pyre Torch notebook: JS cells executed by a sandboxed worker kernel, with
// streamed prints, live-updating plots and decision-boundary charts.
import { $, h, highlightJS, toast } from './common.js';
import { Editor } from './editor.js';
import { lineChart, regionChart } from './charts.js';

const NOTEBOOKS = {
  'Train a classifier (spirals)': [
    `// Tensors look and behave like PyTorch's.
const x = torch.tensor([[1, 2], [3, 4]])
print(x.matmul(x.T))
print('shape', x.shape, 'mean', x.mean().item())`,
    `// Autograd: build any expression, call backward().
const w = torch.tensor([2, -1], { requiresGrad: true })
const loss = w.pow(2).sum()          // loss = w0² + w1²
loss.backward()
print('loss', loss.item(), ' grad', w.grad)   // grad = 2w = [4, -2]`,
    `// Two interleaved spirals: not linearly separable.
const [X, Y] = datasets.spirals(150)
const { nn, optim } = torch
const model = new nn.Sequential(new nn.Linear(2, 64), new nn.ReLU(), new nn.Linear(64, 64), new nn.ReLU(), new nn.Linear(64, 2))
print(model)
print(model.numParameters(), 'parameters')`,
    `// Train for 150 epochs; the loss chart updates live.
const opt = new optim.AdamW(model.parameters(), { lr: 0.01 })
const loader = new torch.data.DataLoader(new torch.data.TensorDataset(X, Y), { batchSize: 32, shuffle: true })
const losses = []
for (let epoch = 1; epoch <= 150; epoch++) {
  let total = 0
  for (const [xb, yb] of loader) {
    const l = nn.crossEntropy(model(xb), yb)
    opt.zeroGrad(); l.backward(); opt.step()
    total += l.item()
  }
  losses.push(total / loader.length)
  if (epoch % 5 === 0) plot('training loss', losses)
}
print('accuracy', (torch.accuracy(model(X), Y) * 100).toFixed(1) + '%')`,
    `// What did it learn? Colour = predicted class over the plane.
boundary(model, X, Y)`,
  ],
  'Regression: fit sin(x)': [
    `const [x, y] = datasets.sine(128)
const { nn, optim } = torch
const net = new nn.Sequential(new nn.Linear(1, 32), new nn.Tanh(), new nn.Linear(32, 32), new nn.Tanh(), new nn.Linear(32, 1))
const opt = new optim.Adam(net.parameters(), { lr: 0.01 })
const history = []
for (let step = 0; step <= 800; step++) {
  const loss = nn.mseLoss(net(x), y)
  opt.zeroGrad(); loss.backward(); opt.step()
  history.push(Math.log10(loss.item()))
  if (step % 40 === 0) plot('log10(MSE)', history)
}`,
    `// Compare prediction and target across the range
const pred = torch.noGrad(() => net(x))
plot('fit', { 'sin(x)': y, 'network': pred })`,
  ],
  'Pyre kernels as tensor ops': [
    `// Any Pyre @kernel can run as a tensor operation.
const smoothstep = torch.kernel(\`
buffer v: [float]
buffer out: [float]

@kernel
fn op(id: int):
    let t = clamp(v[id], 0.0, 1.0)
    out[id] = t * t * (3.0 - 2.0 * t)
\`)
const xs = torch.linspace(-0.25, 1.25, 64)
const { out } = smoothstep({ v: xs, out: torch.zeros(64) })
plot('smoothstep', { input: xs, output: out })`,
  ],
  'Blank notebook': ['print(torch.version)'],
};

let worker = null;
let cells = [];
const running = new Set();

function startKernel() {
  worker?.terminate();
  worker = new Worker(new URL('./torch-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const cell = cells.find((c) => c.id === data.cell);
    if (!cell) return;
    if (data.type === 'out') cell.out.append(h('pre', { class: 'nb-text' }, data.text));
    else if (data.type === 'error') { cell.out.append(h('pre', { class: 'nb-text err' }, data.text)); finish(cell, data.ms, true); }
    else if (data.type === 'done') finish(cell, data.ms);
    else if (data.type === 'plot') {
      let c = cell.charts.get(data.name);
      const series = data.series.map((s) => ({ name: s.name, values: s.values.map((y, i) => ({ x: i, y })) }));
      const allPos = series.every((s) => s.values.every((v) => v.y >= 0));
      if (!c) {
        const box = h('div', { class: 'nb-chart' }, h('div', { class: 'small muted' }, data.name));
        const area = h('div');
        box.append(area);
        cell.out.append(box);
        c = lineChart(area, { series, label: data.name, xFormat: (i) => `#${i}`, yFormat: allPos ? undefined : (v) => v.toFixed(2), area: series.length === 1 });
        cell.charts.set(data.name, c);
      } else c.update({ series });
    } else if (data.type === 'region') {
      const box = h('div', { class: 'nb-chart' }, h('div', { class: 'small muted' }, data.name));
      const area = h('div');
      box.append(area);
      cell.out.append(box);
      regionChart(area, data);
    }
  };
  worker.onerror = (e) => toast(`Kernel error: ${e.message}`, 'err');
  $('#kernel-state').textContent = 'Kernel ready';
}

function finish(cell, ms, failed = false) {
  running.delete(cell.id);
  cell.el.classList.remove('running');
  cell.status.textContent = `${failed ? 'failed' : 'done'} · ${ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`}`;
  $('#kernel-state').textContent = running.size ? 'Running…' : 'Kernel ready';
  cell.resolve?.(!failed);
}

function run(cell) {
  cell.out.replaceChildren();
  cell.charts = new Map();
  cell.el.classList.add('running');
  cell.status.textContent = 'running…';
  running.add(cell.id);
  $('#kernel-state').textContent = 'Running…';
  worker.postMessage({ op: 'run', cell: cell.id, code: cell.editor.value });
  return new Promise((resolve) => { cell.resolve = resolve; });
}

let nextId = 1;
function addCell(code = '', after = null) {
  const id = nextId++;
  const host = h('div', { class: 'nb-editor' });
  const out = h('div', { class: 'nb-out', 'aria-live': 'polite' });
  const status = h('span', { class: 'small dim' }, '');
  const cell = { id, out, status, charts: new Map() };
  const el = h('section', { class: 'nb-cell' },
    h('div', { class: 'nb-head' },
      h('button', { class: 'btn small', title: 'Run (Ctrl/⌘+Enter)', onclick: () => run(cell) }, '▶ Run'),
      status, h('span', { class: 'spacer' }),
      h('button', { class: 'btn small ghost', 'aria-label': 'Delete cell', onclick: () => { cells = cells.filter((c) => c !== cell); el.remove(); save(); } }, '✕')),
    host, out);
  cell.el = el;
  cell.editor = new Editor(host, { value: code, highlight: highlightJS, label: 'Notebook cell (JavaScript)', comment: '//', onRun: () => run(cell), onChange: save });
  const lines = Math.max(3, code.split('\n').length);
  host.style.height = `${Math.min(520, lines * 21.6 + 30)}px`;
  if (after) { after.el.after(el); cells.splice(cells.indexOf(after) + 1, 0, cell); } else { $('#cells').append(el); cells.push(cell); }
  return cell;
}

function load(name) {
  for (const c of cells) c.el.remove();
  cells = [];
  for (const code of NOTEBOOKS[name]) addCell(code);
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem('chroma.notebook', JSON.stringify({ name: $('#nb-example').value, cells: cells.map((c) => c.editor.value) })); } catch { /* storage unavailable */ }
  }, 400);
}

const sel = $('#nb-example');
for (const k of Object.keys(NOTEBOOKS)) sel.append(h('option', { value: k }, k));
sel.addEventListener('change', () => { load(sel.value); save(); });
$('#run-all').addEventListener('click', async () => { for (const c of cells) { if (!(await run(c))) break; } });
$('#restart').addEventListener('click', () => { startKernel(); for (const c of cells) { running.delete(c.id); c.el.classList.remove('running'); c.status.textContent = ''; } toast('Kernel restarted: variables cleared'); });
$('#add-cell').addEventListener('click', () => { const c = addCell('print("hello")'); c.editor.ta.focus(); save(); });

$('#hero-code').innerHTML = highlightJS(`import torch from 'pyre-lang/torch';
const { nn, optim } = torch;

const model = new nn.Sequential(
  new nn.Linear(2, 64), new nn.ReLU(), new nn.Linear(64, 2));
const opt = new optim.AdamW(model.parameters(), { lr: 0.01 });

for (const [xb, yb] of loader) {
  const loss = nn.crossEntropy(model(xb), yb);
  opt.zeroGrad();
  loss.backward();
  opt.step();
}`);

startKernel();
let restored = null;
try { restored = JSON.parse(localStorage.getItem('chroma.notebook') || 'null'); } catch { restored = null; }
if (restored && Array.isArray(restored.cells) && restored.cells.length) {
  sel.value = NOTEBOOKS[restored.name] ? restored.name : sel.value;
  for (const code of restored.cells) addCell(String(code));
} else load(sel.value);

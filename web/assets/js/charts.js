// Minimal, accessible canvas charts: line/area with crosshair tooltip, and a
// 2D class-region scatter. Palette validated for CVD separation on the dark
// surface (#14141f): orange, violet, blue — always used in this order.
import { h } from './common.js';

export const SERIES = ['#d9661f', '#8f6cf5', '#1a9cc0'];
const INK = { text: '#f2f1f7', muted: '#a3a1b8', dim: '#6f6d86', grid: 'rgba(255,255,255,0.07)', surface: '#14141f' };
const FONT = '12px Inter, ui-sans-serif, system-ui, sans-serif';

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/**
 * lineChart(el, { series: [{ name, values: [{x, y}] }], xFormat, yFormat, area })
 * Returns { update(data) }. Values share x positions across series.
 */
export function lineChart(el, opts) {
  el.classList.add('chart');
  const canvas = h('canvas', { role: 'img' });
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const legend = h('div', { class: 'chart-legend' });
  el.replaceChildren(legend, h('div', { class: 'chart-plot' }, canvas, tip));
  let data = opts;
  let hover = -1;
  const ctx = canvas.getContext('2d');

  function layout() {
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    const r = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * r) || canvas.height !== Math.round(hgt * r)) {
      canvas.width = Math.round(w * r);
      canvas.height = Math.round(hgt * r);
    }
    return { w, hgt, r };
  }

  function draw() {
    const { w, hgt, r } = layout();
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const series = data.series || [];
    const n = series[0]?.values.length || 0;
    const pad = { l: 40, r: 12, t: 10, b: 24 };
    const pw = w - pad.l - pad.r;
    const ph = hgt - pad.t - pad.b;
    const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values.map((v) => v.y))));
    const X = (i) => pad.l + (n <= 1 ? pw / 2 : (i / (n - 1)) * pw);
    const Y = (v) => pad.t + ph - (v / max) * ph;
    ctx.font = FONT;
    // recessive grid + y labels
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let k = 0; k <= 4; k++) {
      const v = (max / 4) * k;
      const y = Y(v);
      ctx.strokeStyle = INK.grid;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.l, Math.round(y) + 0.5); ctx.lineTo(w - pad.r, Math.round(y) + 0.5); ctx.stroke();
      ctx.fillStyle = INK.dim;
      ctx.fillText((data.yFormat || (max < 10 ? (x) => String(+x.toFixed(2)) : compact.format))(v), pad.l - 8, y);
    }
    // x labels: first, middle, last
    ctx.textBaseline = 'top';
    if (n) {
      for (const i of [...new Set([0, Math.floor((n - 1) / 2), n - 1])]) {
        ctx.textAlign = i === 0 ? 'left' : i === n - 1 ? 'right' : 'center';
        ctx.fillText((data.xFormat || String)(series[0].values[i].x), X(i), pad.t + ph + 8);
      }
    }
    // series
    series.forEach((s, si) => {
      const color = SERIES[si % SERIES.length];
      if (data.area && si === 0 && n > 1) {
        const g = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
        g.addColorStop(0, `${color}55`);
        g.addColorStop(1, `${color}00`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(X(0), Y(0));
        s.values.forEach((v, i) => ctx.lineTo(X(i), Y(v.y)));
        ctx.lineTo(X(n - 1), Y(0));
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      s.values.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v.y)) : ctx.moveTo(X(i), Y(v.y))));
      ctx.stroke();
      if (n === 1) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(X(0), Y(s.values[0].y), 4, 0, Math.PI * 2); ctx.fill(); }
    });
    // crosshair + markers
    if (hover >= 0 && hover < n) {
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(X(hover)) + 0.5, pad.t); ctx.lineTo(Math.round(X(hover)) + 0.5, pad.t + ph); ctx.stroke();
      series.forEach((s, si) => {
        ctx.fillStyle = INK.surface;
        ctx.beginPath(); ctx.arc(X(hover), Y(s.values[hover].y), 6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = SERIES[si % SERIES.length];
        ctx.beginPath(); ctx.arc(X(hover), Y(s.values[hover].y), 4, 0, Math.PI * 2); ctx.fill();
      });
    }
    canvas.setAttribute('aria-label', `${data.label || 'Chart'}: ${series.map((s) => `${s.name} latest ${s.values.at(-1)?.y ?? 0}`).join(', ')}`);
    return { X, n, pad, pw };
  }

  function renderLegend() {
    const series = data.series || [];
    legend.replaceChildren(...(series.length > 1 ? series.map((s, i) => h('span', {}, h('i', { class: 'swatch', 'data-i': i }), s.name)) : []));
    legend.querySelectorAll('.swatch').forEach((sw) => { sw.style.background = SERIES[Number(sw.dataset.i) % SERIES.length]; });
  }

  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const { n, pad, pw } = draw();
    if (!n) return;
    const x = e.clientX - rect.left;
    hover = Math.max(0, Math.min(n - 1, Math.round(((x - pad.l) / Math.max(1, pw)) * (n - 1))));
    draw();
    const series = data.series;
    tip.hidden = false;
    tip.replaceChildren(h('b', {}, (data.xFormat || String)(series[0].values[hover].x)),
      ...series.map((s, i) => h('div', {}, h('i', { class: 'swatch', 'data-i': i }), `${s.name} `, h('strong', {}, (data.yFormat || compact.format)(s.values[hover].y)))));
    tip.querySelectorAll('.swatch').forEach((sw) => { sw.style.background = SERIES[Number(sw.dataset.i) % SERIES.length]; });
    const tx = Math.min(rect.width - tip.offsetWidth - 4, Math.max(4, x + 12));
    tip.style.left = `${tx}px`;
    tip.style.top = '8px';
  });
  canvas.addEventListener('pointerleave', () => { hover = -1; tip.hidden = true; draw(); });
  new ResizeObserver(() => draw()).observe(canvas);
  renderLegend();
  draw();
  return { update(next) { data = { ...data, ...next }; renderLegend(); draw(); } };
}

/**
 * Class regions + points: { grid: Int8Array (gx*gy), gx, gy, bounds:[x0,x1,y0,y1], points:[[x,y,c]...] }
 */
export function regionChart(el, d) {
  el.classList.add('chart');
  const canvas = h('canvas', { role: 'img', 'aria-label': 'Decision regions and training points' });
  const legend = h('div', { class: 'chart-legend' });
  el.replaceChildren(legend, h('div', { class: 'chart-plot square' }, canvas));
  const classes = [...new Set(d.points.map((p) => p[2]))].sort();
  legend.replaceChildren(...classes.map((c) => h('span', {}, h('i', { class: 'swatch', 'data-c': c }), `class ${c}`)));
  legend.querySelectorAll('.swatch').forEach((sw) => { sw.style.background = SERIES[Number(sw.dataset.c) % SERIES.length]; });
  const draw = () => {
    const r = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    canvas.width = Math.round(w * r);
    canvas.height = Math.round(w * r);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(r, 0, 0, r, 0, 0);
    const [x0, x1, y0, y1] = d.bounds;
    const cw = w / d.gx;
    const ch = w / d.gy;
    for (let j = 0; j < d.gy; j++) for (let i = 0; i < d.gx; i++) {
      ctx.fillStyle = `${SERIES[d.grid[j * d.gx + i] % SERIES.length]}33`;
      ctx.fillRect(Math.floor(i * cw), Math.floor(w - (j + 1) * ch), Math.ceil(cw) + 1, Math.ceil(ch) + 1);
    }
    for (const [x, y, c] of d.points) {
      const px = ((x - x0) / (x1 - x0)) * w;
      const py = w - ((y - y0) / (y1 - y0)) * w;
      ctx.fillStyle = INK.surface;
      ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = SERIES[c % SERIES.length];
      ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill();
    }
  };
  new ResizeObserver(draw).observe(canvas);
  draw();
}

/** Ranked list with proportional bars (for "top pages" style tables). */
export function barList(el, rows, { empty = 'No data yet', format = (n) => compact.format(n) } = {}) {
  if (!rows.length) { el.replaceChildren(h('p', { class: 'small dim' }, empty)); return; }
  const max = Math.max(...rows.map((r) => r.n));
  el.replaceChildren(...rows.map((r) => {
    const bar = h('i');
    bar.style.width = `${Math.max(2, (r.n / max) * 100)}%`;
    return h('div', { class: 'barrow' }, bar, h('span', { class: 'k' }, String(r.key)), h('span', { class: 'v' }, format(r.n)));
  }));
}

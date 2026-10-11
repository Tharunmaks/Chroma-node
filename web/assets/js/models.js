// Model library: browse, search and preview 100,000+ procedural models.
import { $, $$, h, api, copyText, toast } from './common.js';
import { FAMILIES, FAMILY, TOTAL, TOTAL_3D, TOTAL_4D, get, globalIndex, search, build } from 'helix/catalog.js';
import { ThumbRenderer } from 'helix/thumbs.js';
import { Helix, THREE, supported } from 'helix';

const PAGE = 60;
const state = { tab: 'library', family: null, dims: 'all', query: '', next: 0, done: false, loading: false };
const thumbs = supported() ? new ThumbRenderer(176) : null;
const nf = new Intl.NumberFormat('en');

// ---------- header KPIs ----------
$('#kpis').append(
  h('div', { class: 'kpi' }, h('b', {}, nf.format(TOTAL)), h('span', {}, 'models')),
  h('div', { class: 'kpi' }, h('b', {}, nf.format(TOTAL_3D)), h('span', {}, '3D surfaces & knots')),
  h('div', { class: 'kpi' }, h('b', {}, nf.format(TOTAL_4D)), h('span', {}, '4D polytopes & curves')),
  h('div', { class: 'kpi' }, h('b', {}, String(FAMILIES.length)), h('span', {}, 'families')),
);

// ---------- family chips ----------
function renderChips() {
  const box = $('#families');
  box.replaceChildren(
    h('button', { class: 'chip', 'aria-pressed': String(!state.family), onclick: () => setFamily(null) }, 'All families'),
    ...FAMILIES.filter((f) => state.dims === 'all' || String(f.dims) === state.dims).map((f) => h('button', {
      class: 'chip', 'aria-pressed': String(state.family === f.id), title: f.description, onclick: () => setFamily(f.id),
    }, f.name, h('small', {}, nf.format(f.count)))),
  );
}
function setFamily(id) { state.family = id; renderChips(); reset(); }

for (const b of $$('#dims button')) {
  b.addEventListener('click', () => {
    state.dims = b.dataset.d;
    for (const x of $$('#dims button')) x.setAttribute('aria-selected', String(x === b));
    if (state.family && state.dims !== 'all' && String(FAMILY[state.family].dims) !== state.dims) state.family = null;
    renderChips();
    reset();
  });
}
for (const b of $$('#tabs button')) {
  b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    for (const x of $$('#tabs button')) x.setAttribute('aria-selected', String(x === b));
    $('#families').hidden = state.tab !== 'library';
    $('#dims').hidden = state.tab !== 'library';
    reset();
  });
}
let qTimer;
$('#q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.query = $('#q').value; reset(); }, 220); });
$('#random').addEventListener('click', () => openPreview(get(Math.floor(Math.random() * TOTAL))));

// ---------- grid ----------
const io = thumbs && new IntersectionObserver((entries) => {
  for (const e of entries) {
    const c = e.target;
    if (e.isIntersecting) thumbs.request(c.model, c);
    else thumbs.cancel(c);
  }
}, { rootMargin: '300px' });

function card(model, { author } = {}) {
  const canvas = h('canvas', { width: 176, height: 176, 'aria-hidden': 'true' });
  canvas.model = model;
  const el = h('button', { class: 'mcard', type: 'button', onclick: () => openPreview(model), 'aria-label': `${model.name}: ${model.label}` },
    h('div', { class: 'thumb' }, h('span', { class: 'dim-tag' }, `${model.family.dims}D`), canvas),
    h('div', { class: 'meta' }, h('b', {}, model.saved ? model.saved.name : model.name), h('span', {}, author ? `by ${author}` : model.label)));
  if (io) io.observe(canvas);
  return el;
}

function familiesInView() {
  return FAMILIES.filter((f) => (!state.family || f.id === state.family) && (state.dims === 'all' || String(f.dims) === state.dims));
}

// Browsing order: a fixed shuffle inside each family (index * k mod count
// with k coprime to count) so neighbours differ, and families interleaved
// round-robin in the "all" view. Model ids are never affected.
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const stride = (n) => { if (n < 3) return 1; let k = Math.round(n * 0.618) | 1; while (gcd(k, n) !== 1) k += 2; return k; };
const STRIDES = Object.fromEntries(FAMILIES.map((f) => [f.id, stride(f.count)]));
const pretty = (f, k) => get(`${f.id}/${(k * STRIDES[f.id]) % f.count}`);

/** Next page of models for the current filter. */
function nextPage() {
  if (state.query.trim()) {
    const res = search(state.query, { limit: PAGE, offset: state.next, family: state.family });
    const filtered = res.filter((m) => state.dims === 'all' || String(m.family.dims) === state.dims);
    state.next += PAGE;
    if (res.length < PAGE) state.done = true;
    return filtered;
  }
  const fams = familiesInView();
  if (!state.cursors) state.cursors = Object.fromEntries(fams.map((f) => [f.id, 0]));
  const out = [];
  while (out.length < PAGE) {
    const open = fams.filter((f) => state.cursors[f.id] < f.count);
    if (!open.length) { state.done = true; break; }
    for (const f of open) {
      if (out.length >= PAGE) break;
      out.push(pretty(f, state.cursors[f.id]++));
    }
  }
  state.next += out.length;
  return out;
}

async function loadMore() {
  if (state.loading || state.done) return;
  state.loading = true;
  const grid = $('#grid');
  if (state.tab === 'community') {
    try {
      const { models, total } = await api('GET', `/api/models/gallery?limit=${PAGE}&offset=${state.next}`);
      state.next += models.length;
      if (state.next >= total) state.done = true;
      for (const m of models) {
        if (m.family === 'pyre') continue;
        const fam = FAMILY[m.family];
        if (!fam) continue;
        const model = { id: `saved:${m.id}`, family: fam, index: 0, params: m.params, name: m.name, label: fam.label(m.params), saved: m };
        grid.append(card(model, { author: m.author }));
      }
      $('#status').textContent = total ? `${nf.format(total)} community models` : 'No community models yet — save one from the studio and make it public.';
    } catch (err) {
      $('#status').textContent = err.message;
      state.done = true;
    }
  } else {
    const items = nextPage();
    for (const m of items) grid.append(card(m));
    const total = state.query.trim() ? null : familiesInView().reduce((s, f) => s + f.count, 0);
    $('#status').textContent = total !== null
      ? `Showing ${nf.format(Math.min(state.next, total))} of ${nf.format(total)} models — scroll for more`
      : grid.children.length ? `${grid.children.length} matches${state.done ? '' : ' so far — scroll for more'}` : 'No models match. Try a family name, numbers like "3 7", or an id like knot/12.';
  }
  state.loading = false;
}

function reset() {
  for (const c of $$('#grid canvas')) { io?.unobserve(c); thumbs?.cancel(c); }
  $('#grid').replaceChildren();
  state.next = 0;
  state.cursors = null;
  state.done = false;
  loadMore();
}

new IntersectionObserver((e) => { if (e[0].isIntersecting) loadMore(); }, { rootMargin: '800px' }).observe($('#sentinel'));

// ---------- preview ----------
let viewer = null;
let current = null;
function codeFor(model) {
  return `import { Helix } from 'helix';\nimport { build } from 'helix/catalog.js';\n\nconst engine = new Helix(canvas, { autoRotate: true });\nconst model = engine.add(build('${model.family.id}', ${JSON.stringify(model.params)}));\n${model.family.dims === 4 ? 'engine.onFrame((t, dt) => model.update(dt)); // rotate through 4D\n' : ''}engine.start();`;
}

function openPreview(model) {
  const dlg = $('#preview');
  $('#pv-family').textContent = `${model.family.name} · ${model.family.dims}D`;
  $('#pv-name').textContent = model.saved ? model.saved.name : `${model.name}`;
  $('#pv-desc').textContent = model.family.description;
  $('#pv-badge').textContent = model.family.dims === 4 ? '4D · rotating in xw / yw / zw' : 'Drag to orbit';
  $('#pv-params').replaceChildren(
    h('tr', {}, h('td', {}, 'id'), h('td', {}, h('code', {}, model.saved ? model.saved.id : model.id))),
    ...model.family.params.map((p) => h('tr', {}, h('td', {}, p.label), h('td', {}, p.options ? p.options[model.params[p.key]] : String(model.params[p.key])))),
  );
  $('#pv-code').textContent = codeFor(model);
  $('#pv-open').href = model.saved ? `/studio#m=${model.saved.id}` : `/studio#id=${model.id}`;
  if (!dlg.open) dlg.showModal();
  if (!supported()) return;
  if (!viewer) {
    viewer = new Helix($('#pv-view canvas'), { autoRotate: true, camera: [2.8, 1.4, 3.6], maxPixelRatio: 2 });
    viewer.onFrame((t, dt) => { if (current && current.isPolytope4D) current.update(dt); });
    viewer.start();
  }
  if (current) { viewer.remove(current); current.isPolytope4D ? current.dispose() : current.geometry.dispose(); }
  const mat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color().setHSL(0.72, 0.5, 0.7), metalness: 0.55, roughness: 0.25, clearcoat: 0.6 });
  current = build(model.family.id, model.params, { material: mat });
  viewer.add(current);
}
$('#pv-close').addEventListener('click', () => $('#preview').close());
$('#preview').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$('#pv-copy').addEventListener('click', (e) => copyText($('#pv-code').textContent, e.currentTarget));

renderChips();
const hashId = decodeURIComponent(location.hash.slice(1));
if (hashId && get(hashId)) openPreview(get(hashId));
reset();
if (!thumbs) toast('WebGL2 is unavailable, so thumbnails are not rendered; the catalogue still works.', 'err');
export { globalIndex };

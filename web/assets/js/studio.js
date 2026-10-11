// Studio: edit any library model (or write one in Pyre), pick materials,
// rotate through 4D, save to your account and export glTF / OBJ / PNG.
import { $, $$, h, api, me, toast, copyText } from './common.js';
import { Editor } from './editor.js';
import { Helix, THREE, createStarfield, supported } from 'helix';
import { FAMILIES, FAMILY, get, build, fromGrid } from 'helix/catalog.js';
import { PLANES } from 'helix/four.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { SHADERS } from './shaders.js';

const PYRE_EXAMPLES = {
  'Bumpy sphere': `# u and v run from 0 to 1. Return a point in 3D.
fn surface(u: float, v: float) -> vec3:
    let a = u * TAU
    let b = v * PI
    let r = 1.0 + 0.22 * sin(7.0 * a) * sin(5.0 * b)
    return vec3(r * sin(b) * cos(a), r * cos(b), r * sin(b) * sin(a))
`,
  'Twisted ribbon': `fn surface(u: float, v: float) -> vec3:
    let a = u * TAU * 2.0
    let w = (v - 0.5) * 0.8
    let p = vec2(w, 0.0) * rotate(a * 1.5)
    return vec3((1.4 + p.x) * cos(a), p.y + 0.3 * sin(3.0 * a), (1.4 + p.x) * sin(a))
`,
  'Noise terrain': `fn surface(u: float, v: float) -> vec3:
    let p = vec2(u, v) * 6.0
    let height = fbm(p) * 1.2 - 0.4
    return vec3((u - 0.5) * 4.0, height, (v - 0.5) * 4.0)
`,
  'Gyroid shell': `fn surface(u: float, v: float) -> vec3:
    let a = u * TAU
    let b = v * PI
    let d = vec3(sin(b) * cos(a), cos(b), sin(b) * sin(a))
    let g = sin(d.x * 6.0) * cos(d.y * 6.0) + sin(d.y * 6.0) * cos(d.z * 6.0) + sin(d.z * 6.0) * cos(d.x * 6.0)
    return d * (1.2 + 0.12 * g)
`,
  '4D: Hopf fibration': `# A 4D model: return a vec4. Helix rotates it through the w axis.
fn surface4(u: float, v: float) -> vec4:
    let eta = PI * 0.25 + 0.2 * sin(v * TAU * 3.0)
    let a = u * TAU
    let b = v * TAU
    return vec4(cos(eta) * cos(a + b), cos(eta) * sin(a + b), sin(eta) * cos(b), sin(eta) * sin(b))
`,
  '4D: Twisted torus': `fn surface4(u: float, v: float) -> vec4:
    let a = u * TAU
    let b = v * TAU
    return vec4(cos(a), sin(a), cos(b + 3.0 * a) * 0.8, sin(b + 2.0 * a) * 0.8)
`,
};

const MATERIALS = {
  pearl: { name: 'Pearl', make: (c) => new THREE.MeshPhysicalMaterial({ color: c, metalness: 0.2, roughness: 0.25, clearcoat: 1, sheen: 0.6 }) },
  chrome: { name: 'Chrome', make: (c) => new THREE.MeshPhysicalMaterial({ color: c, metalness: 1, roughness: 0.08, clearcoat: 1 }) },
  glass: { name: 'Glass', make: (c) => new THREE.MeshPhysicalMaterial({ color: c, metalness: 0, roughness: 0.12, transmission: 0.92, thickness: 1.4, ior: 1.45 }) },
  matte: { name: 'Matte clay', make: (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, metalness: 0 }) },
  toonish: { name: 'Flat shaded', make: (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, flatShading: true }) },
  normals: { name: 'Normals', make: () => new THREE.MeshNormalMaterial() },
  ...Object.fromEntries(['iridescent', 'lava', 'hologram', 'toon'].map((k) => [`pyre:${k}`, { name: `Pyre · ${SHADERS[k].name}`, pyre: SHADERS[k].source }])),
};

const state = { mode: 'catalog', family: 'knot', index: 912, params: null, saved: null, object: null, dims: 3, pyreSource: PYRE_EXAMPLES['Bumpy sphere'] };
const nf = new Intl.NumberFormat('en');

if (!supported()) {
  $('#stage').replaceChildren(h('div', { class: 'empty' }, 'WebGL2 is not available in this browser, so the studio cannot render.'));
  throw new Error('no webgl2');
}
const engine = new Helix($('#stage canvas'), { autoRotate: true, camera: [3.2, 1.6, 4.4], maxPixelRatio: 2 });
const stars = createStarfield({ count: 1400, radius: 26 });
engine.add(stars);
engine.onFrame((t, dt) => {
  if (state.object && state.object.isPolytope4D && !state.paused4d) state.object.update(dt);
  stars.rotation.y = t * 0.01;
});
engine.start();

// ---------- worker for Pyre-defined models ----------
const worker = new Worker('/assets/js/pyre-worker.js', { type: 'module' });
let seq = 0;
const pending = new Map();
worker.onmessage = ({ data }) => { const p = pending.get(data.id); if (!p) return; pending.delete(data.id); data.ok ? p.resolve(data) : p.reject(new Error(data.error)); };
const call = (msg) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });

// ---------- material ----------
const matSel = $('#material');
for (const [k, m] of Object.entries(MATERIALS)) matSel.append(h('option', { value: k }, m.name));
matSel.value = 'pearl';
let pyreMat = null;
function makeMaterial() {
  const def = MATERIALS[matSel.value];
  const color = new THREE.Color($('#color').value);
  let mat;
  if (def.pyre) {
    pyreMat ||= engine.material(def.pyre);
    pyreMat.setSource(def.pyre);
    mat = pyreMat;
  } else mat = def.make(color);
  mat.wireframe = $('#t-wire').getAttribute('aria-pressed') === 'true';
  mat.side = THREE.DoubleSide;
  return mat;
}
function applyMaterial() {
  const o = state.object;
  if (!o || o.isPolytope4D) {
    if (o && state.colorChosen) { o.colorA.set($('#color').value); o.colorB.set('#8b5cff'); o.update(0); }
    return;
  }
  const old = o.material;
  o.material = makeMaterial();
  if (old !== o.material && old !== pyreMat) old.dispose();
}
matSel.addEventListener('change', applyMaterial);
$('#color').addEventListener('input', () => { state.colorChosen = true; applyMaterial(); });

// ---------- showing objects ----------
function show(obj) {
  if (state.object) {
    engine.remove(state.object);
    if (state.object.isPolytope4D) state.object.dispose();
    else { state.object.geometry.dispose(); if (state.object.material !== pyreMat) state.object.material.dispose(); }
  }
  state.object = obj;
  state.dims = obj.isPolytope4D ? 4 : 3;
  if (obj.isPolytope4D) {
    for (const p of PLANES) obj.speeds[p] = state.speeds ? state.speeds[p] : obj.speeds[p];
    if (state.colorChosen) obj.colorA.set($('#color').value);
    obj.update(0);
  } else obj.material = makeMaterial();
  engine.add(obj);
  $('#sec-4d').hidden = state.dims !== 4;
  const info = obj.isPolytope4D ? `${obj.count.toLocaleString()} vertices · 4D` : `${((obj.geometry.index ? obj.geometry.index.count : obj.geometry.attributes.position.count) / 3).toLocaleString()} triangles`;
  $('#stage-info').textContent = info;
}

// ---------- catalog mode ----------
const famSel = $('#family');
for (const f of FAMILIES) famSel.append(h('option', { value: f.id }, `${f.name} (${nf.format(f.count)})`));

let rebuildTimer = null;
function rebuild(quality = 'high') {
  const fam = FAMILY[state.family];
  try {
    show(build(fam.id, state.params, { quality }));
  } catch (err) {
    toast(err.message, 'err');
  }
  $('#title').textContent = state.saved ? state.saved.name : `${fam.name.replace(/s$/, '')} #${state.index}`;
  $('#subtitle').textContent = `${fam.label(state.params)} · ${state.custom ? 'edited' : `${fam.id}/${state.index}`}`;
  if (!$('#name').value || $('#name').dataset.auto === '1') { $('#name').value = `${fam.name.replace(/s$/, '')} ${fam.label(state.params)}`.slice(0, 80); $('#name').dataset.auto = '1'; }
}
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuild('low');
  rebuildTimer = setTimeout(() => rebuild('high'), 280);
}

function renderParams() {
  const fam = FAMILY[state.family];
  const box = $('#params');
  box.replaceChildren(...fam.params.map((p) => {
    if (p.options) {
      const sel = h('select', {}, ...p.options.map((o, i) => h('option', { value: i }, o)));
      sel.value = state.params[p.key];
      sel.addEventListener('change', () => { state.params[p.key] = Number(sel.value); state.custom = true; rebuild(); });
      return h('label', {}, p.label, sel);
    }
    const out = h('output', {}, fmt(state.params[p.key]));
    const input = h('input', { type: 'range', min: p.min, max: p.max, step: p.step, value: state.params[p.key], 'aria-label': p.label });
    input.addEventListener('input', () => { state.params[p.key] = Number(input.value); out.textContent = fmt(input.value); state.custom = true; scheduleRebuild(); });
    return h('label', { class: 'range-row' }, h('span', {}, p.label), out, input);
  }));
  $('#index').max = fam.count - 1;
  $('#index').value = state.index;
}
const fmt = (v) => (Number.isInteger(+v) ? String(+v) : (+v).toFixed(2));

function loadCatalog(familyId, index) {
  const fam = FAMILY[familyId];
  const i = Math.max(0, Math.min(fam.count - 1, Math.floor(index) || 0));
  state.family = familyId;
  state.index = i;
  state.params = { ...get(`${familyId}/${i}`).params };
  state.custom = false;
  state.saved = null;
  famSel.value = familyId;
  renderParams();
  rebuild();
  history.replaceState(null, '', `#id=${familyId}/${i}`);
}
famSel.addEventListener('change', () => loadCatalog(famSel.value, 0));
$('#index').addEventListener('change', () => loadCatalog(state.family, Number($('#index').value)));
$('#prev').addEventListener('click', () => { if (state.mode === 'catalog') loadCatalog(state.family, (state.index - 1 + FAMILY[state.family].count) % FAMILY[state.family].count); });
$('#next').addEventListener('click', () => { if (state.mode === 'catalog') loadCatalog(state.family, (state.index + 1) % FAMILY[state.family].count); });
$('#rand').addEventListener('click', () => {
  setMode('catalog');
  const m = get(Math.floor(Math.random() * FAMILIES.reduce((s, f) => s + f.count, 0)));
  loadCatalog(m.family.id, m.index);
});

// ---------- 4D controls ----------
state.speeds = { xy: 0, xz: 0.11, xw: 0.37, yz: 0, yw: 0.23, zw: 0.29 };
$('#planes').append(...PLANES.map((p) => {
  const out = h('output', {}, fmt(state.speeds[p]));
  const input = h('input', { type: 'range', min: -1.5, max: 1.5, step: 0.01, value: state.speeds[p] });
  input.addEventListener('input', () => { state.speeds[p] = Number(input.value); out.textContent = fmt(input.value); if (state.object?.isPolytope4D) state.object.speeds[p] = state.speeds[p]; });
  return h('label', { class: 'range-row' }, h('span', {}, `Rotate ${p.toUpperCase()} plane`), out, input);
}), (() => {
  const out = h('output', {}, '2.4');
  const input = h('input', { type: 'range', min: 1.3, max: 8, step: 0.05, value: 2.4 });
  input.addEventListener('input', () => { out.textContent = fmt(input.value); if (state.object?.isPolytope4D) { state.object.distance = Number(input.value); state.object.update(0); } });
  return h('label', { class: 'range-row' }, h('span', {}, '4D camera distance'), out, input);
})(), h('button', { class: 'btn small', onclick: (e) => { state.paused4d = !state.paused4d; e.currentTarget.textContent = state.paused4d ? 'Resume 4D rotation' : 'Pause 4D rotation'; } }, 'Pause 4D rotation'));

// ---------- Pyre mode ----------
const exSel = $('#pyre-example');
for (const k of Object.keys(PYRE_EXAMPLES)) exSel.append(h('option', { value: k }, k));
const editor = new Editor($('#pyre-editor'), { value: state.pyreSource, onRun: () => buildPyre() });
exSel.addEventListener('change', () => { editor.value = PYRE_EXAMPLES[exSel.value]; buildPyre(); });
$('#pyre-build').addEventListener('click', () => buildPyre());
let pyreTimer = null;
editor.onChange = () => { clearTimeout(pyreTimer); pyreTimer = setTimeout(() => buildPyre(), 600); };
async function buildPyre() {
  const diag = $('#pyre-diag');
  const seg = Number($('#pyre-seg').value);
  diag.className = 'diag';
  diag.textContent = 'Building…';
  try {
    const r = await call({ op: 'surface', source: editor.value, segments: seg, segments2: r4(editor.value) ? Math.round(seg / 2) : Math.round(seg / 2) });
    const obj = fromGrid(r.positions, r.segments, r.segments2, r.dims);
    show(obj);
    editor.setError(0);
    diag.className = 'diag ok';
    diag.textContent = `✓ ${r.dims}D model from ${((r.segments + 1) * (r.segments2 + 1)).toLocaleString()} points in ${r.ms.toFixed(0)} ms`;
    $('#title').textContent = state.saved ? state.saved.name : 'Pyre model';
    $('#subtitle').textContent = r.dims === 4 ? 'surface4(u, v) → vec4' : 'surface(u, v) → vec3';
  } catch (err) {
    diag.className = 'diag err';
    diag.textContent = err.message;
    const m = /:(\d+):\d+: error/.exec(err.message);
    editor.setError(m ? Number(m[1]) : 0);
  }
}
const r4 = (src) => /fn\s+surface4\s*\(/.test(src);
$('#pyre-seg').addEventListener('change', () => buildPyre());

function setMode(mode) {
  state.mode = mode;
  for (const b of $$('#mode button')) b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  $('#sec-model').hidden = mode !== 'catalog';
  $('#sec-pyre').hidden = mode !== 'pyre';
  for (const id of ['#prev', '#next']) $(id).hidden = mode !== 'catalog';
  if (mode === 'pyre') buildPyre(); else rebuild();
}
for (const b of $$('#mode button')) b.addEventListener('click', () => setMode(b.dataset.mode));

// ---------- toggles ----------
const toggle = (id, fn) => $(id).addEventListener('click', (e) => { const on = e.currentTarget.getAttribute('aria-pressed') !== 'true'; e.currentTarget.setAttribute('aria-pressed', String(on)); fn(on); });
toggle('#t-rotate', (on) => { engine.controls.autoRotate = on; });
toggle('#t-bloom', (on) => (on ? engine.enableBloom({ strength: 0.55, radius: 0.5, threshold: 0.55 }) : engine.disableBloom()));
toggle('#t-wire', () => applyMaterial());
toggle('#t-stars', (on) => { stars.visible = on; });

// ---------- export ----------
function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function exportable() {
  const o = state.object;
  if (o.isPolytope4D) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(o.positions.slice(), 3));
    g.setIndex(Array.from(o.lines.geometry.index.array));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: $('#color').value }));
  }
  const m = o.material.isRawShaderMaterial ? new THREE.MeshStandardMaterial({ color: $('#color').value }) : o.material;
  return new THREE.Mesh(o.geometry, m);
}
const fileBase = () => ($('#name').value || 'model').replace(/[^\w-]+/g, '-').toLowerCase();
$('#export-glb').addEventListener('click', async () => {
  const data = await new GLTFExporter().parseAsync(exportable(), { binary: true });
  download(new Blob([data], { type: 'model/gltf-binary' }), `${fileBase()}.glb`);
});
$('#export-obj').addEventListener('click', () => download(new Blob([new OBJExporter().parse(exportable())], { type: 'text/plain' }), `${fileBase()}.obj`));
$('#export-png').addEventListener('click', () => h('a', { href: engine.screenshot(), download: `${fileBase()}.png` }).click());
$('#copy-code').addEventListener('click', (e) => {
  const code = state.mode === 'pyre'
    ? `// Pyre models are built from source at runtime; save the model and load it in the studio.\n`
    : `import { Helix } from 'helix';\nimport { build } from 'helix/catalog.js';\n\nconst engine = new Helix(document.querySelector('canvas'), { autoRotate: true });\nconst model = engine.add(build('${state.family}', ${JSON.stringify(state.params)}));\n${state.dims === 4 ? 'engine.onFrame((t, dt) => model.update(dt));\n' : ''}engine.start();`;
  copyText(code, e.currentTarget);
});

// ---------- save / my models ----------
$('#name').addEventListener('input', () => { $('#name').dataset.auto = '0'; });
async function refreshMine() {
  const box = $('#mine');
  const who = await me();
  if (!who.user) { box.replaceChildren(h('p', { class: 'small muted' }, 'Sign in to save models to your account. ', h('a', { href: '/dashboard' }, 'Sign in →'))); return; }
  const { models } = await api('GET', '/api/models');
  box.replaceChildren(...(models.length ? models.map((m) => h('button', { class: 'item', onclick: () => loadSaved(m) }, m.name, h('span', {}, `${m.family}${m.public ? ' · public' : ''}`))) : [h('p', { class: 'small muted' }, 'Nothing saved yet.')]));
}
function loadSaved(m) {
  state.saved = m;
  $('#name').value = m.name;
  $('#name').dataset.auto = '0';
  $('#public').checked = m.public;
  if (m.family === 'pyre') {
    editor.value = m.source;
    setMode('pyre');
  } else {
    state.family = m.family;
    state.params = { ...m.params };
    state.custom = true;
    famSel.value = m.family;
    setMode('catalog');
    renderParams();
    rebuild();
  }
  history.replaceState(null, '', `#m=${m.id}`);
}
$('#save').addEventListener('click', async () => {
  const msg = $('#save-msg');
  const who = await me(true);
  if (!who.user) { msg.replaceChildren(h('div', { class: 'alert info' }, 'Sign in to save. ', h('a', { href: '/dashboard' }, 'Sign in or create an account'))); return; }
  const body = state.mode === 'pyre'
    ? { name: $('#name').value || 'Pyre model', family: 'pyre', params: {}, source: editor.value, public: $('#public').checked }
    : { name: $('#name').value || 'Model', family: state.family, params: state.params, public: $('#public').checked };
  try {
    const owned = state.saved && (await api('GET', '/api/models')).models.some((x) => x.id === state.saved.id);
    const r = owned ? await api('PUT', `/api/models/${state.saved.id}`, body) : await api('POST', '/api/models', body);
    state.saved = r.model;
    history.replaceState(null, '', `#m=${r.model.id}`);
    msg.replaceChildren(h('div', { class: 'alert ok' }, `Saved "${r.model.name}"${r.model.public ? ' and shared in the gallery' : ''}.`));
    refreshMine();
  } catch (err) {
    msg.replaceChildren(h('div', { class: 'alert err' }, err.message));
  }
});

// ---------- boot ----------
async function boot() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get('m')) {
    try { loadSaved((await api('GET', `/api/models/${encodeURIComponent(params.get('m'))}`)).model); refreshMine(); return; } catch (err) { toast(err.message, 'err'); }
  }
  if (params.get('pyre')) { setMode('pyre'); refreshMine(); return; }
  const ref = params.get('id') && get(params.get('id'));
  if (ref) loadCatalog(ref.family.id, ref.index); else loadCatalog('knot', 912);
  refreshMine();
}
boot();

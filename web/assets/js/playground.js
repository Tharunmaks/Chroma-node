// Playground: edit Pyre, see it live on a 3D model, inspect GLSL/WGSL/JS,
// run kernels on the CPU and WebGPU, and deploy the result.
import { $, $$, h, api, me, toast, copyText, highlightC } from './common.js';
import { Editor } from './editor.js';
import { Helix, Models, THREE, supported } from 'helix';
import { compileAll } from 'pyre';
import { SHADERS, KERNELS } from './shaders.js';

const AUTO = new Set(['time', 'resolution', 'mouse']);
const KERNEL_N = 64;

// ---------- state ----------
let result = null; // last successful compileAll()
let mode = 'fragment';
let modelChoice = 'auto';
let outTab = 'glsl';
let lastRun = null;
let engine = null;
let material = null;
let mesh = null;
let kernelViz = null;

// ---------- examples ----------
const exampleSel = $('#example');
const groupS = h('optgroup', { label: 'Shaders' });
for (const [k, v] of Object.entries(SHADERS)) groupS.append(h('option', { value: `s:${k}` }, v.name));
const groupK = h('optgroup', { label: 'Compute kernels' });
for (const [k, v] of Object.entries(KERNELS)) groupK.append(h('option', { value: `k:${k}` }, v.name));
exampleSel.append(groupS, groupK);

function exampleSource(id) {
  const [kind, key] = id.split(':');
  return (kind === 'k' ? KERNELS : SHADERS)[key];
}

// ---------- editor ----------
let timer = null;
const editor = new Editor($('#editor'), {
  onChange: () => { clearTimeout(timer); timer = setTimeout(build, 300); },
  onRun: () => build(true),
});

function initialSource() {
  const params = new URLSearchParams(location.hash.slice(1));
  const s = params.get('s');
  if (s) {
    try {
      const bytes = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      const text = new TextDecoder().decode(bytes);
      if (params.get('m')) modelChoice = params.get('m');
      exampleSel.value = '';
      return text;
    } catch { /* fall through to the default */ }
  }
  const ex = params.get('example');
  if (ex && exampleSource(ex)) { exampleSel.value = ex; return exampleSource(ex).source; }
  exampleSel.value = 's:iridescent';
  return SHADERS.iridescent.source;
}

exampleSel.addEventListener('change', () => {
  const ex = exampleSource(exampleSel.value);
  if (!ex) return;
  editor.value = ex.source;
  modelChoice = 'auto';
  $('#model').value = 'auto';
  if (material && ex.uniforms) material.initial = ex.uniforms;
  build(true);
});

// ---------- 3D ----------
if (supported()) {
  engine = new Helix($('#view canvas'), { controls: true, autoRotate: true, camera: [0, 0.3, 4.6], maxPixelRatio: 2 });
  material = engine.material(null, { uniforms: SHADERS.iridescent.uniforms || {} });
  let frames = 0;
  let last = performance.now();
  engine.onFrame(() => {
    frames++;
    const now = performance.now();
    if (now - last > 1000) { $('#fps').textContent = `${frames} fps`; frames = 0; last = now; }
    if (mesh && modelChoice !== 'glb' && currentModel() === 'plane') fitPlane();
    if (kernelViz && kernelViz.tick) kernelViz.tick();
  });
  engine.start();
} else {
  $('#view').append(h('div', { class: 'empty' }, 'WebGL2 is not available here. Compiling still works — see the output panel.'));
}

function currentModel() {
  if (modelChoice !== 'auto') return modelChoice;
  const ex = exampleSel.value && exampleSel.value.startsWith('s:') ? exampleSource(exampleSel.value) : null;
  const inputs = result ? result.meta.fragmentInputs : [];
  const is2D = inputs.length > 0 && inputs.every((i) => i === 'uv' || i === 'frag');
  if (is2D) return 'plane';
  return ex && ex.model !== 'plane' ? ex.model : 'torusKnot';
}

function fitPlane() {
  const dist = engine.camera.position.length();
  const hgt = 2 * dist * Math.tan(THREE.MathUtils.degToRad(engine.camera.fov / 2));
  mesh.scale.set((hgt * engine.camera.aspect) / 4, hgt / 4, 1);
  mesh.quaternion.copy(engine.camera.quaternion);
}

let shownModel = null;
function showModel(force = false) {
  if (!engine || mode !== 'fragment') return;
  const m = currentModel();
  if (m === 'glb') return;
  if (m === shownModel && mesh && !force) return;
  shownModel = m;
  if (mesh) { engine.remove(mesh); if (mesh.geometry) mesh.geometry.dispose(); }
  mesh = engine.mesh(Models[m](), material);
  if (m === 'helix') mesh.scale.setScalar(0.8);
  const flat = m === 'plane';
  engine.controls.enableRotate = !flat;
  engine.controls.enableZoom = !flat;
  engine.controls.autoRotate = !flat && $('#spin').getAttribute('aria-pressed') === 'true';
  if (flat) { engine.camera.position.set(0, 0, 4.6); engine.controls.target.set(0, 0, 0); engine.camera.lookAt(0, 0, 0); }
  engine.add(mesh);
}

$('#model').addEventListener('change', async (e) => {
  if (e.target.value === 'glb') {
    const input = h('input', { type: 'file', accept: '.glb,.gltf' });
    input.addEventListener('change', async () => {
      const f = input.files[0];
      if (!f) return;
      try {
        const root = await engine.load(f, { material });
        if (mesh) engine.remove(mesh);
        mesh = root;
        shownModel = 'glb';
        modelChoice = 'glb';
        engine.controls.enableRotate = true;
        engine.add(root);
        toast(`Loaded ${f.name}`);
      } catch (err) {
        toast(`Could not load model: ${err.message}`, 'err');
      }
    });
    input.click();
    return;
  }
  modelChoice = e.target.value;
  showModel(true);
});

$('#spin').addEventListener('click', (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  e.currentTarget.setAttribute('aria-pressed', String(on));
  if (engine) engine.controls.autoRotate = on && currentModel() !== 'plane';
});
$('#bloom').addEventListener('click', (e) => {
  if (!engine) return;
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  e.currentTarget.setAttribute('aria-pressed', String(on));
  if (on) engine.enableBloom({ strength: 0.6, radius: 0.5, threshold: 0.55 });
  else engine.disableBloom();
});
$('#shot').addEventListener('click', () => {
  if (!engine) return;
  const a = h('a', { href: engine.screenshot(), download: 'pyre-shader.png' });
  a.click();
});

// ---------- build ----------
function build(explicit = false) {
  const src = editor.value;
  const diag = $('#diag');
  const t0 = performance.now();
  try {
    result = compileAll(src, { filename: 'shader.pyre' });
  } catch (err) {
    result = null;
    diag.className = 'diag err';
    diag.textContent = err.format ? err.format() : String(err.message || err);
    editor.setError(err.line || 0);
    renderOut();
    return;
  }
  const ms = (performance.now() - t0).toFixed(1);
  editor.setError(0);
  const meta = result.meta;
  mode = meta.entry || 'library';
  diag.className = 'diag ok';
  diag.textContent = `✓ compiled in ${ms} ms · ${meta.entry ? '@' + meta.entry : 'library (add @fragment or @kernel to preview)'}`
    + (meta.uniforms.length ? ` · uniforms: ${meta.uniforms.map((u) => `${u.name}: ${u.type}`).join(', ')}` : '')
    + (meta.buffers.length ? ` · buffers: ${meta.buffers.map((b) => b.name).join(', ')}` : '');
  $('#run-tab').hidden = mode !== 'kernel';
  if (mode !== 'kernel' && outTab === 'run') selectTab('glsl');
  if (mode === 'kernel' && explicit) selectTab('run');

  if (engine) {
    clearKernelViz();
    if (mode === 'fragment') {
      const r = material.setSource(src);
      if (!r.ok) { diag.className = 'diag err'; diag.textContent = r.message; }
      showModel();
    } else {
      if (mesh) { engine.remove(mesh); mesh = null; shownModel = null; }
      if (mode === 'kernel') runKernel();
    }
  } else if (mode === 'kernel') runKernel();
  buildControls();
  renderOut();
}

// ---------- uniform controls ----------
function buildControls() {
  const box = $('#controls');
  box.replaceChildren();
  if (!result || mode !== 'fragment' || !material) return;
  for (const u of result.meta.uniforms) {
    if (AUTO.has(u.name)) continue;
    const uni = material.uniforms[u.name];
    if (!uni) continue;
    if (u.type === 'float' || u.type === 'int') {
      const v = typeof uni.value === 'number' ? uni.value : 0;
      const max = Math.max(2, Math.abs(v) * 2);
      const input = h('input', { type: 'range', min: u.type === 'int' ? 0 : -max, max, step: u.type === 'int' ? 1 : max / 200, value: v });
      const out = h('span', { class: 'dim' }, ` ${(+v).toFixed(2)}`);
      input.addEventListener('input', () => { uni.value = Number(input.value); out.textContent = ` ${(+input.value).toFixed(2)}`; });
      box.append(h('label', {}, h('span', {}, u.name, out), input));
    } else if (u.type === 'vec3' && /col|tint|colou?r/i.test(u.name)) {
      const c = new THREE.Color(uni.value.x, uni.value.y, uni.value.z);
      const input = h('input', { type: 'color', value: `#${c.getHexString()}` });
      input.addEventListener('input', () => { const n = new THREE.Color(input.value); uni.value.set(n.r, n.g, n.b); });
      box.append(h('label', {}, u.name, input));
    } else if (u.type.startsWith('vec')) {
      const n = Number(u.type[3]);
      const comps = ['x', 'y', 'z', 'w'].slice(0, n);
      const row = h('div', { class: 'row' });
      for (const k of comps) {
        const input = h('input', { type: 'range', min: -2, max: 2, step: 0.01, value: uni.value[k], 'aria-label': `${u.name}.${k}` });
        input.addEventListener('input', () => { uni.value[k] = Number(input.value); });
        row.append(input);
      }
      box.append(h('label', {}, u.name, row));
    }
  }
}

// ---------- output ----------
function selectTab(name) {
  outTab = name;
  for (const t of $$('.tab[data-out]')) t.setAttribute('aria-selected', String(t.dataset.out === name));
  renderOut();
}
for (const t of $$('.tab[data-out]')) t.addEventListener('click', () => selectTab(t.dataset.out));

function renderOut() {
  const out = $('#out');
  if (!result) { out.textContent = '// fix the error to see compiled output'; return; }
  if (outTab === 'run') { out.textContent = lastRun || '// press ⌘/Ctrl+Enter to run the kernel'; return; }
  const code = result[outTab];
  out.innerHTML = code ? highlightC(code) : `<span class="c">// ${result.errors[outTab] || 'not available for this program'}</span>`;
}
$('#copy-out').addEventListener('click', (e) => copyText($('#out').textContent, e.currentTarget));

// ---------- CPU worker (runs generated JS outside the page) ----------
const worker = new Worker(new URL('./pyre-worker.js', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map();
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  if (data.ok) p.resolve(data);
  else p.reject(new Error(data.error));
};
const call = (msg) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  worker.postMessage({ ...msg, id });
});

// ---------- kernels ----------
function kernelInputs(meta) {
  const n = KERNEL_N;
  const names = meta.buffers.map((b) => b.name);
  const particles = names.includes('px') && names.includes('py');
  const buffers = {};
  for (const b of meta.buffers) {
    if (particles) {
      buffers[b.name] = Array.from({ length: n }, () => (b.name === 'py' ? 1 + Math.random() * 4 : b.name === 'px' ? (Math.random() - 0.5) * 4 : b.name === 'vx' ? (Math.random() - 0.5) * 2 : 0));
    } else if (b.elem === 'int') buffers[b.name] = Array(n).fill(0);
    else buffers[b.name] = Array.from({ length: n }, (_, i) => (b.name === names[0] ? i : 1));
  }
  const uniforms = {};
  for (const u of meta.uniforms) {
    if (u.type === 'int') uniforms[u.name] = n;
    else if (u.type === 'float') uniforms[u.name] = u.name === 'dt' ? 0.016 : 2;
  }
  return { buffers, uniforms, particles };
}

function fmt(arr, k = 16) {
  const a = Array.from(arr.slice(0, k), (x) => +(+x).toFixed(4));
  return `[${a.join(', ')}${arr.length > k ? `, … (${arr.length})` : ''}]`;
}

async function runKernel() {
  const meta = result.meta;
  const input = kernelInputs(meta);
  const lines = [`# kernel · ${KERNEL_N} threads · workgroup ${meta.workgroupSize}`, `uniforms ${JSON.stringify(input.uniforms)}`, ''];
  let cpu;
  try {
    const r = await call({ op: 'run', source: editor.value, uniforms: input.uniforms, buffers: input.buffers, count: KERNEL_N });
    cpu = r.buffers;
    lines.push(`CPU (JavaScript backend, in a worker): ${r.ms.toFixed(2)} ms`);
    for (const [k, v] of Object.entries(cpu)) lines.push(`  ${k} = ${fmt(v)}`);
  } catch (err) {
    lines.push(`CPU run failed: ${err.message}`);
  }
  lastRun = lines.join('\n');
  renderOut();
  if (engine && cpu) showKernelViz(meta, kernelInputs(meta), cpu);

  if (!navigator.gpu) {
    lines.push('', 'WebGPU: not available in this browser (the CPU result above is exact).');
    lastRun = lines.join('\n');
    renderOut();
    return;
  }
  try {
    const t0 = performance.now();
    const gpu = await runOnWebGPU(result.wgsl, meta, input);
    lines.push('', `WebGPU: ${(performance.now() - t0).toFixed(2)} ms (including upload/readback)`);
    let maxErr = 0;
    for (const [k, v] of Object.entries(gpu)) {
      lines.push(`  ${k} = ${fmt(v)}`);
      if (cpu) v.forEach((x, i) => { maxErr = Math.max(maxErr, Math.abs(x - cpu[k][i]) / Math.max(1, Math.abs(x))); });
    }
    if (cpu) lines.push('', maxErr < 1e-4 ? `✓ GPU matches CPU (max relative error ${maxErr.toExponential(1)})` : `⚠ GPU and CPU differ (max relative error ${maxErr.toExponential(1)})`);
  } catch (err) {
    lines.push('', `WebGPU run failed: ${err.message}`);
  }
  lastRun = lines.join('\n');
  renderOut();
}

async function runOnWebGPU(code, meta, input) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('no GPU adapter');
  const device = await adapter.requestDevice();
  const module = device.createShaderModule({ code });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) throw new Error(errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; '));
  const entries = [];
  if (meta.uniforms.length) {
    const data = new ArrayBuffer(meta.uniformLayout.size);
    const view = new DataView(data);
    for (const f of meta.uniformLayout.fields) {
      const v = input.uniforms[f.name] ?? 0;
      if (f.type === 'int') view.setInt32(f.offset, v, true);
      else if (f.type === 'float') view.setFloat32(f.offset, v, true);
    }
    const buf = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buf, 0, data);
    entries.push({ binding: 0, resource: { buffer: buf } });
  }
  const bufs = meta.buffers.map((b) => {
    const arr = b.elem === 'int' ? Int32Array.from(input.buffers[b.name]) : Float32Array.from(input.buffers[b.name]);
    const gb = device.createBuffer({ size: Math.max(16, arr.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(gb, 0, arr);
    entries.push({ binding: b.binding, resource: { buffer: gb, size: arr.byteLength } });
    return { b, gb, bytes: arr.byteLength };
  });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'cs_main' } });
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
  pass.dispatchWorkgroups(Math.ceil(KERNEL_N / meta.workgroupSize));
  pass.end();
  const reads = bufs.map(({ b, gb, bytes }) => {
    const r = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyBufferToBuffer(gb, 0, r, 0, bytes);
    return { b, r };
  });
  device.queue.submit([enc.finish()]);
  const out = {};
  for (const { b, r } of reads) {
    await r.mapAsync(GPUMapMode.READ);
    out[b.name] = Array.from(b.elem === 'int' ? new Int32Array(r.getMappedRange()) : new Float32Array(r.getMappedRange()));
    r.unmap();
  }
  device.destroy();
  return out;
}

// Kernel results in 3D: animated particles for px/py kernels, bars otherwise.
function clearKernelViz() {
  if (!kernelViz) return;
  if (kernelViz.key) worker.postMessage({ op: 'drop', key: kernelViz.key });
  engine.remove(kernelViz.object);
  kernelViz.object.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
  kernelViz = null;
}

function showKernelViz(meta, input, cpu) {
  clearKernelViz();
  const group = new THREE.Group();
  if (input.particles) {
    const key = `p${++seq}`;
    let ready = false;
    let busy = false;
    call({ op: 'init', key, source: editor.value, uniforms: input.uniforms, buffers: input.buffers }).then(() => { ready = true; });
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(KERNEL_N * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.12, color: '#ff8a4c' }));
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(6, 3), new THREE.MeshStandardMaterial({ color: '#221c3a', roughness: 0.9 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.5;
    group.add(pts, floor);
    kernelViz = {
      object: group,
      key,
      tick() {
        if (!ready || busy) return;
        busy = true;
        call({ op: 'step', key, count: KERNEL_N }).then(({ buffers }) => {
          for (let i = 0; i < KERNEL_N; i++) pos.set([buffers.px[i], buffers.py[i] - 1.5, (i / KERNEL_N - 0.5) * 2], i * 3);
          geo.attributes.position.needsUpdate = true;
          busy = false;
        }).catch(() => { ready = false; });
      },
    };
  } else {
    const name = meta.buffers[meta.buffers.length - 1].name;
    const values = Array.from(cpu[name]);
    const max = Math.max(1e-6, ...values.map(Math.abs));
    const n = Math.min(values.length, KERNEL_N);
    const cols = 8;
    const box = new THREE.BoxGeometry(0.22, 1, 0.22);
    box.translate(0, 0.5, 0);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.1 });
    const bars = new THREE.InstancedMesh(box, mat, n);
    const m4 = new THREE.Matrix4();
    const color = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const hgt = Math.max(0.02, (Math.abs(values[i]) / max) * 2);
      m4.makeScale(1, hgt, 1).setPosition((i % cols - cols / 2 + 0.5) * 0.32, -1, (Math.floor(i / cols) - n / cols / 2 + 0.5) * 0.32);
      bars.setMatrixAt(i, m4);
      bars.setColorAt(i, color.setHSL(0.05 + 0.75 * (i / n), 0.85, 0.58));
    }
    group.add(bars);
    kernelViz = { object: group };
    toast(`Showing "${name}" as 3D bars`, 'ok', 2200);
  }
  engine.add(group);
}

// ---------- share / download ----------
$('#share').addEventListener('click', (e) => {
  const bytes = new TextEncoder().encode(editor.value);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  const s = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const url = `${location.origin}/playground#s=${s}${modelChoice !== 'auto' ? `&m=${modelChoice}` : ''}`;
  history.replaceState(null, '', url);
  copyText(url, e.currentTarget);
});
$('#download').addEventListener('click', () => {
  const a = h('a', { href: URL.createObjectURL(new Blob([editor.value], { type: 'text/plain' })), download: 'shader.pyre' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---------- deploy ----------
const b64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
};

function siteFiles(source) {
  const importmap = '{ "imports": { "three": "/vendor/three/three.module.js", "three/addons/": "/vendor/three/addons/", "pyre": "/vendor/pyre/index.js", "helix": "/assets/js/helix/helix.js" } }';
  if (mode === 'kernel') {
    return {
      'api/kernel.pyre': source,
      'index.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pyre Function</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07070c;color:#eee;font:16px system-ui}main{max-width:640px;padding:24px}pre{background:#111119;padding:14px;border-radius:12px;white-space:pre-wrap}button{font:600 15px system-ui;padding:10px 16px;border:0;border-radius:10px;background:linear-gradient(90deg,#ff7a1a,#ff3d81);color:#fff;cursor:pointer}</style></head>
<body><main><h1>Pyre Function</h1><p>POST <code id="u"></code></p><button id="go">Run with sample input</button><pre id="out"></pre></main>
<script type="module">
const project = location.pathname.split('/')[2];
const url = '/api/fn/' + project + '/kernel';
document.getElementById('u').textContent = url;
document.getElementById('go').onclick = async () => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(kernelInputs(result.meta))}) });
  document.getElementById('out').textContent = JSON.stringify(await r.json(), null, 2);
};
</script></body></html>`,
    };
  }
  const model = currentModel() === 'glb' ? 'torusKnot' : currentModel();
  return {
    'shader.pyre': source,
    'index.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pyre shader</title>
<style>html,body{margin:0;height:100%;background:#07070c}canvas{width:100%;height:100%;display:block}a{position:fixed;left:16px;bottom:14px;color:#aaa;font:13px system-ui;text-decoration:none}</style>
<script type="importmap">${importmap}</script></head>
<body><canvas id="c" aria-label="Pyre shader"></canvas><a href="/">Made with Chroma · Pyre · Helix</a>
<script type="module">
import { Helix, Models } from 'helix';
const engine = new Helix(document.getElementById('c'), { autoRotate: ${model !== 'plane'}, camera: [0, 0.3, 4.6] });
const mat = engine.material(await fetch('./shader.pyre').then((r) => r.text()), { uniforms: ${JSON.stringify(Object.fromEntries(Object.entries(material?.uniforms || {}).filter(([k]) => !AUTO.has(k)).map(([k, u]) => [k, typeof u.value === 'number' ? u.value : u.value.toArray ? u.value.toArray() : 0])))} });
for (const [k, v] of Object.entries(mat.initial)) mat.set(k, v);
const mesh = engine.add(engine.mesh(Models.${model}(), mat));
${model === 'plane' ? `engine.controls.enableRotate = false; engine.controls.enableZoom = false;
engine.onFrame(() => { const d = engine.camera.position.length(); const h = 2 * d * Math.tan(engine.camera.fov * Math.PI / 360); mesh.scale.set(h * engine.camera.aspect / 4, h / 4, 1); });` : ''}
engine.start();
</script></body></html>`,
  };
}

$('#deploy').addEventListener('click', async () => {
  const dlg = $('#deploy-dlg');
  const msg = $('#deploy-msg');
  msg.replaceChildren();
  if (!result || !['fragment', 'kernel'].includes(mode)) {
    toast('Fix the program first (it needs a @fragment or @kernel).', 'err');
    return;
  }
  const who = await me(true);
  if (!who.user) {
    msg.append(h('div', { class: 'alert info' }, 'You need an account to deploy. ', h('a', { href: '/dashboard' }, 'Sign in or sign up'), ' — it takes 10 seconds.'));
  }
  $('#deploy-go').disabled = !who.user;
  dlg.showModal();
});

$('#deploy-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'go') return;
  e.preventDefault();
  const msg = $('#deploy-msg');
  const name = $('#deploy-name').value.trim().toLowerCase();
  const go = $('#deploy-go');
  go.disabled = true;
  msg.replaceChildren(h('div', { class: 'alert info' }, 'Deploying…'));
  try {
    try {
      await api('GET', `/api/projects/${encodeURIComponent(name)}`);
    } catch (err) {
      if (err.status !== 404) throw err;
      await api('POST', '/api/projects', { name });
    }
    const files = Object.entries(siteFiles(editor.value)).map(([path, text]) => ({ path, data: b64(text) }));
    const res = await api('POST', `/api/projects/${encodeURIComponent(name)}/deployments`, { files, target: 'production' });
    if (res.deployment.status !== 'READY') throw new Error(res.deployment.log.filter((l) => l.level === 'error').map((l) => l.message).join('\n') || 'build failed');
    msg.replaceChildren(h('div', { class: 'alert ok' }, 'Live at ', h('a', { href: res.production, target: '_blank', rel: 'noopener' }, location.origin + res.production)));
  } catch (err) {
    msg.replaceChildren(h('div', { class: 'alert err' }, err.message));
  } finally {
    go.disabled = false;
  }
});

editor.value = initialSource();
if (modelChoice !== 'auto') $('#model').value = modelChoice;
build(true);

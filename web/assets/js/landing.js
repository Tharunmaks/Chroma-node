// Landing page: hero scene, live Pyre shader showcase, Helix model viewer
// and the deploy terminal animation.
import { $, $$, h, highlightPyre, highlightC, highlightJS } from './common.js';
import { get, TOTAL } from 'helix/catalog.js';
import { ThumbRenderer } from 'helix/thumbs.js';
import { Helix, Models, THREE, createDNA, createStarfield, supported } from 'helix';
import { compileAll } from 'pyre';
import { SHADERS } from './shaders.js';

const mobile = matchMedia('(max-width: 860px)').matches;
const strong = (navigator.hardwareConcurrency || 4) >= 4 && !mobile;

if (!supported()) {
  document.documentElement.classList.add('webgl-fallback');
} else {
  heroScene();
  pyreShowcase();
  helixViewer();
  modelStrip();
}
terminal();
torchCode();

function modelStrip() {
  const strip = $('#strip');
  if (!strip) return;
  const thumbs = new ThumbRenderer(160);
  const picks = ['knot/912', 'polytope/5', 'harmonic/7595', 'supershape/10125', 'duoprism/566', 'lissajous/13567', 'shell/871', 'clifford/242', 'superquadric/1979', 'hypershape/1234', 'surface/6', 'polyhedron/155'];
  const io = new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting) return;
    io.disconnect();
    for (const id of picks.slice(0, matchMedia('(max-width: 860px)').matches ? 6 : 12)) {
      const m = get(id);
      const c = h('canvas', { width: 160, height: 160, 'aria-hidden': 'true' });
      strip.append(h('a', { href: `/studio#id=${id}`, 'aria-label': `Open ${m.name} in the studio` }, c, h('span', {}, `${m.family.dims}D · ${m.label}`)));
      thumbs.request(m, c);
    }
  }, { rootMargin: '400px' });
  io.observe(strip);
}

function torchCode() {
  const el = $('#torch-code');
  if (!el) return;
  el.innerHTML = highlightJS(`import torch from 'pyre-lang/torch';
const { nn, optim, data } = torch;

const model = new nn.Sequential(
  new nn.Linear(2, 64), new nn.ReLU(),
  new nn.Linear(64, 2));
const opt = new optim.AdamW(model.parameters(), { lr: 0.01 });

for (const [xb, yb] of loader) {
  const loss = nn.crossEntropy(model(xb), yb);
  opt.zeroGrad(); loss.backward(); opt.step();
}
// epoch 200  loss 0.0412  accuracy 98.7%`);
}

// ---------------- hero ----------------
function heroScene() {
  const canvas = $('.hero canvas.stage');
  const engine = new Helix(canvas, { controls: false, bloom: strong ? { strength: 0.55, radius: 0.5, threshold: 0.62 } : false, camera: [0, 0, 8], maxPixelRatio: strong ? 1.75 : 1.25 });
  const world = new THREE.Group();
  engine.add(world);

  const knotMat = engine.material(SHADERS.iridescent.source);
  const knot = engine.mesh(Models.torusKnot(), knotMat);
  knot.scale.setScalar(mobile ? 0.95 : 1.15);
  world.add(knot);

  const dna = createDNA({ pairs: mobile ? 30 : 52, height: 11, radius: 1.25, turns: 3.4 });
  dna.rotation.z = -0.5;
  dna.position.set(1.2, 0, -6.5);
  world.add(dna);

  const stars = createStarfield({ count: mobile ? 700 : 1800 });
  engine.add(stars);

  // orbiting crystals
  const crystals = new THREE.Group();
  const crystalMat = new THREE.MeshStandardMaterial({ color: '#d7ccff', metalness: 0.9, roughness: 0.12, flatShading: true });
  const shards = [];
  for (let i = 0; i < 7; i++) {
    const m = new THREE.Mesh(Models.crystal(), crystalMat);
    m.scale.setScalar(0.12 + Math.random() * 0.12);
    m.userData = { r: 2.0 + Math.random() * 0.7, a: (i / 7) * Math.PI * 2, y: (Math.random() - 0.5) * 2.2, s: 0.2 + Math.random() * 0.3 };
    shards.push(m);
    crystals.add(m);
  }
  world.add(crystals);

  const layout = () => {
    const wide = window.innerWidth > 980;
    world.position.set(wide ? 2.6 : 0, wide ? 0 : 1.6, 0);
    canvas.style.opacity = wide ? '1' : '0.55';
  };
  layout();
  window.addEventListener('resize', layout);

  // scroll drives the camera through a critically damped follow, so the
  // motion stays smooth even when the browser delivers scroll events in bursts
  let scrollTarget = 0;
  let scroll = 0;
  window.addEventListener('scroll', () => { scrollTarget = Math.min(1, window.scrollY / window.innerHeight); }, { passive: true });

  engine.onFrame((t, dt) => {
    scroll += (scrollTarget - scroll) * (1 - Math.exp(-dt * 6));
    knot.rotation.x = t * 0.18;
    knot.rotation.y = t * 0.27;
    dna.rotation.y = t * 0.25;
    stars.rotation.y = t * 0.01;
    for (const s of shards) {
      const u = s.userData;
      const a = u.a + t * u.s;
      s.position.set(Math.cos(a) * u.r, u.y + Math.sin(t + u.a) * 0.25, Math.sin(a) * u.r);
      s.rotation.x = t * 0.8 + u.a;
      s.rotation.y = t * 0.6;
    }
    world.rotation.x = engine.pointer.y * 0.18 + scroll * 0.6;
    world.rotation.y = engine.pointer.x * 0.35;
    engine.camera.position.z = 8 + scroll * 4;
    engine.camera.position.y = -scroll * 1.5;
    engine.camera.lookAt(0, 0, 0);
  });
  engine.start();
}

// ---------------- Pyre showcase ----------------
function pyreShowcase() {
  const view = $('#pyre-view canvas');
  const engine = new Helix(view, { controls: true, autoRotate: true, zoom: false, camera: [0, 0.4, 4.6], maxPixelRatio: 1.75 });
  const order = ['iridescent', 'lava', 'hologram', 'toon'];
  let current = order[0];
  let mesh = null;
  let output = 'pyre';
  let compiled = null;
  const mat = engine.material(SHADERS[current].source);
  const pre = $('#pyre-src');

  function show(name) {
    current = name;
    const s = SHADERS[name];
    mat.setSource(s.source);
    compiled = compileAll(s.source);
    if (mesh) { engine.remove(mesh); mesh.geometry.dispose(); }
    mesh = engine.mesh(Models[s.model](), mat);
    if (s.model === 'helix') mesh.scale.setScalar(0.75);
    engine.add(mesh);
    for (const c of $$('#pyre-chips .chip')) c.setAttribute('aria-pressed', String(c.dataset.k === name));
    render();
  }
  function render() {
    if (output === 'pyre') pre.innerHTML = highlightPyre(SHADERS[current].source);
    else pre.innerHTML = highlightC(compiled[output] || '');
  }
  for (const k of order) {
    $('#pyre-chips').append(h('button', { class: 'chip', 'data-k': k, 'aria-pressed': 'false', onclick: () => show(k) }, SHADERS[k].name));
  }
  for (const t of $$('#pyre-code .tab')) {
    t.addEventListener('click', () => {
      output = t.dataset.out;
      for (const x of $$('#pyre-code .tab')) x.setAttribute('aria-selected', String(x === t));
      render();
    });
  }
  engine.onFrame((t) => { if (mesh) mesh.rotation.x = Math.sin(t * 0.3) * 0.3; });
  show(current);
  engine.start();
}

// ---------------- Helix viewer ----------------
function helixViewer() {
  const box = $('#helix-view');
  const engine = new Helix($('canvas', box), { controls: true, autoRotate: true, bloom: strong ? { strength: 0.45, radius: 0.45, threshold: 0.6 } : false, camera: [0, 0.3, 5.2], maxPixelRatio: 1.75 });
  const mats = {
    chrome: new THREE.MeshPhysicalMaterial({ color: '#ffffff', metalness: 1, roughness: 0.08, clearcoat: 1 }),
    lava: engine.material(SHADERS.lava.source),
    holo: engine.material(SHADERS.hologram.source),
  };
  const models = {
    Helix: () => { const m = new THREE.Mesh(Models.helix(), mats.holo); m.scale.setScalar(0.85); return m; },
    Knot: () => new THREE.Mesh(Models.torusKnot(), mats.chrome),
    Crystal: () => new THREE.Mesh(Models.crystal(), new THREE.MeshStandardMaterial({ color: '#b9a6ff', metalness: 0.6, roughness: 0.15, flatShading: true })),
    Planet: () => new THREE.Mesh(Models.sphere(), mats.lava),
    DNA: () => { const g = createDNA({ pairs: 36, height: 4.4, radius: 0.9, turns: 2 }); return g; },
  };
  let obj = null;
  function show(name, object) {
    if (obj) engine.remove(obj);
    obj = object || models[name]();
    engine.add(obj);
    for (const c of $$('#helix-chips .chip')) c.setAttribute('aria-pressed', String(c.dataset.k === name));
  }
  for (const name of Object.keys(models)) {
    $('#helix-chips').append(h('button', { class: 'chip', 'data-k': name, 'aria-pressed': 'false', onclick: () => show(name) }, name));
  }
  const file = h('input', { type: 'file', accept: '.glb,.gltf', class: 'sr-only', 'aria-label': 'Load a glTF model' });
  const loadFile = async (f) => {
    if (!f) return;
    try {
      show('Your model', await engine.load(f));
    } catch (err) {
      alert(`Could not load that model: ${err.message}`);
    }
  };
  file.addEventListener('change', () => loadFile(file.files[0]));
  $('#helix-chips').append(h('button', { class: 'chip', 'data-k': 'Your model', 'aria-pressed': 'false', onclick: () => file.click() }, 'Your .glb…'), file);
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('dropzone-active'); });
  box.addEventListener('dragleave', () => box.classList.remove('dropzone-active'));
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('dropzone-active');
    loadFile(e.dataTransfer.files[0]);
  });
  engine.onFrame((t) => { if (obj) obj.rotation.y = t * 0.2; });
  show('Helix');
  engine.start();
}

// ---------------- terminal ----------------
function terminal() {
  const pre = $('#term pre');
  if (!pre) return;
  const script = [
    ['cmd', 'chroma init my-site --template helix-starter'],
    ['out', '<span class="t-ok">✓</span> created my-site/ <span class="t-dim">(index.html, scene.js, shaders/lava.pyre, api/saxpy.pyre)</span>'],
    ['cmd', 'cd my-site && chroma deploy'],
    ['out', '<span class="t-dim">› uploading 6 files (14.2 KB)</span>'],
    ['out', '<span class="t-dim">› building</span> shaders/lava.pyre <span class="t-ok">@fragment → glsl, wgsl</span>'],
    ['out', '<span class="t-dim">› building</span> api/saxpy.pyre <span class="t-ok">@kernel → function /api/fn/my-site/saxpy</span>'],
    ['out', '<span class="t-ok">✓ READY</span> in 41 ms'],
    ['out', '  production  <span class="t-link">http://localhost:3000/p/my-site/</span>'],
    ['out', '  preview     <span class="t-link">http://localhost:3000/d/dpl_Xq3v9.../</span>'],
  ];
  let started = false;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const io = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting || started) return;
    started = true;
    io.disconnect();
    run();
  }, { threshold: 0.3 });
  io.observe(pre);

  async function run() {
    const sleep = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
    let html = '';
    for (const [kind, text] of script) {
      if (kind === 'cmd') {
        html += '<span class="t-prompt">❯</span> ';
        for (let i = 1; i <= text.length; i++) {
          pre.innerHTML = html + text.slice(0, i).replace(/&/g, '&amp;') + '<span class="cursor"></span>';
          await sleep(28 + Math.random() * 40);
        }
        html += text.replace(/&/g, '&amp;') + '\n';
        await sleep(350);
      } else {
        html += text + '\n';
        pre.innerHTML = html + '<span class="cursor"></span>';
        await sleep(260);
      }
    }
    pre.innerHTML = html + '<span class="t-prompt">❯</span> <span class="cursor"></span>';
  }
}

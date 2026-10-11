// Helix — Chroma's 3D engine. A thin, friendly layer over Three.js whose
// materials are written in Pyre and compiled to GLSL on the fly.
//
//   import { Helix, Models } from 'helix';
//   const engine = new Helix(canvas, { bloom: true });
//   const mat = engine.material(pyreSource);      // live-compiled Pyre material
//   engine.add(engine.mesh(Models.torusKnot(), mat));
//   engine.start();
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { compile, GLSL_VERTEX } from 'pyre';

export { THREE };

const VERTEX = GLSL_VERTEX.replace(/^#version 300 es\n/, '');
const AUTO_UNIFORMS = { time: 'float', resolution: 'vec2', mouse: 'vec2' };
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function defaultValue(type) {
  switch (type) {
    case 'float': case 'int': return 0;
    case 'vec2': return new THREE.Vector2();
    case 'vec3': return new THREE.Vector3(1, 1, 1);
    case 'vec4': return new THREE.Vector4(1, 1, 1, 1);
    case 'mat4': return new THREE.Matrix4();
    default: return 0;
  }
}

/** A Three.js material whose fragment shader is a Pyre program. */
export class PyreMaterial extends THREE.RawShaderMaterial {
  constructor(source, { uniforms = {}, linearOutput = false, ...params } = {}) {
    super({ vertexShader: VERTEX, fragmentShader: 'precision highp float; out vec4 fragColor; void main() { fragColor = vec4(1.0, 0.0, 1.0, 1.0); }', glslVersion: THREE.GLSL3, ...params });
    this.type = 'PyreMaterial';
    this.meta = null;
    this.error = null;
    this.initial = uniforms;
    // Pyre colours are display (sRGB) values. When Helix renders through the
    // post-processing chain (which tone-maps and sRGB-encodes at the end) they
    // are converted to linear first so they look the same with or without it.
    this.linearOutput = linearOutput;
    if (source) this.setSource(source);
  }

  setLinearOutput(on) {
    if (this.linearOutput === on) return;
    this.linearOutput = on;
    if (this.source) this.setSource(this.source);
  }

  /** Recompile from Pyre source. On error the previous shader keeps running. */
  setSource(source) {
    try {
      const { code, meta } = compile(source, { target: 'glsl', version: false, filename: 'material.pyre' });
      if (meta.entry !== 'fragment') throw new Error('a material needs a @fragment function');
      const next = {};
      for (const u of meta.uniforms) {
        const prev = this.uniforms[u.name];
        const given = this.initial[u.name];
        next[u.name] = prev && this.meta && this.meta.uniforms.some((x) => x.name === u.name && x.type === u.type)
          ? prev
          : { value: given !== undefined ? given : defaultValue(u.type) };
      }
      this.uniforms = next;
      this.fragmentShader = this.linearOutput
        ? code.replace('void main() {', 'vec4 pyre_to_linear(vec4 c) { return vec4(pow(max(c.rgb, vec3(0.0)), vec3(2.2)), c.a); }\n\nvoid main() {')
          .replace(/fragColor = (.+);\n\}\s*$/, 'fragColor = pyre_to_linear($1);\n}\n')
        : code;
      this.meta = meta;
      this.source = source;
      this.error = null;
      this.needsUpdate = true;
      return { ok: true, meta };
    } catch (err) {
      this.error = err;
      return { ok: false, error: err, message: err.format ? err.format() : String(err.message || err) };
    }
  }

  set(name, value) {
    const u = this.uniforms[name];
    if (!u) return this;
    if (u.value && typeof u.value.set === 'function' && Array.isArray(value)) u.value.set(...value);
    else if (u.value && typeof u.value.copy === 'function' && value && typeof value === 'object') u.value.copy(value);
    else u.value = value;
    return this;
  }

  tick(time, resolution, mouse) {
    if (!this.meta) return;
    for (const u of this.meta.uniforms) {
      if (AUTO_UNIFORMS[u.name] !== u.type) continue;
      if (u.name === 'time') this.uniforms.time.value = time;
      else if (u.name === 'resolution') this.uniforms.resolution.value.copy(resolution);
      else if (u.name === 'mouse') this.uniforms.mouse.value.copy(mouse);
    }
  }
}

// ---------------- procedural models ----------------
class HelixCurve extends THREE.Curve {
  constructor(radius = 0.8, height = 3, turns = 2.5, phase = 0) {
    super();
    Object.assign(this, { radius, height, turns, phase });
  }
  getPoint(t, target = new THREE.Vector3()) {
    const a = t * Math.PI * 2 * this.turns + this.phase;
    return target.set(Math.cos(a) * this.radius, (t - 0.5) * this.height, Math.sin(a) * this.radius);
  }
}

export const Models = {
  torusKnot: () => new THREE.TorusKnotGeometry(1, 0.34, 320, 48),
  sphere: () => new THREE.SphereGeometry(1.3, 128, 96),
  icosahedron: (detail = 0) => new THREE.IcosahedronGeometry(1.4, detail),
  box: () => new THREE.BoxGeometry(1.8, 1.8, 1.8, 32, 32, 32),
  torus: () => new THREE.TorusGeometry(1.1, 0.42, 96, 192),
  plane: () => new THREE.PlaneGeometry(4, 4, 1, 1),
  crystal: () => {
    const g = new THREE.OctahedronGeometry(1.4, 0);
    g.scale(0.75, 1.35, 0.75);
    return g;
  },
  /** Two intertwined tubes: the Helix logo as a mesh. */
  helix: ({ turns = 2.5, radius = 0.8, height = 3.2, tube = 0.16 } = {}) => {
    const geos = [0, Math.PI].map((phase) => new THREE.TubeGeometry(new HelixCurve(radius, height, turns, phase), 400, tube, 24, false));
    return mergeGeometries(geos);
  },
};

function mergeGeometries(geos) {
  const merged = new THREE.BufferGeometry();
  const attrs = ['position', 'normal', 'uv'];
  const totals = attrs.map((a) => geos.reduce((s, g) => s + g.attributes[a].array.length, 0));
  attrs.forEach((a, i) => {
    const arr = new Float32Array(totals[i]);
    let off = 0;
    for (const g of geos) { arr.set(g.attributes[a].array, off); off += g.attributes[a].array.length; }
    merged.setAttribute(a, new THREE.BufferAttribute(arr, geos[0].attributes[a].itemSize));
  });
  const index = [];
  let base = 0;
  for (const g of geos) {
    for (const i of g.index.array) index.push(i + base);
    base += g.attributes.position.count;
  }
  merged.setIndex(index);
  return merged;
}

/** DNA-style double helix built from instanced spheres and rungs (great with bloom). */
export function createDNA({ pairs = 46, radius = 1.1, height = 7, turns = 3, colors = ['#ff7a1a', '#ff3d81', '#8b5cff'] } = {}) {
  const group = new THREE.Group();
  const ball = new THREE.SphereGeometry(0.11, 20, 14);
  const balls = new THREE.InstancedMesh(ball, new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.2, toneMapped: false }), pairs * 2);
  const rung = new THREE.CylinderGeometry(0.025, 0.025, 1, 8);
  rung.rotateZ(Math.PI / 2);
  const rungs = new THREE.InstancedMesh(rung, new THREE.MeshStandardMaterial({ color: '#c9c3ff', roughness: 0.4, transparent: true, opacity: 0.45 }), pairs);
  const palette = colors.map((c) => new THREE.Color(c));
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3(1, 1, 1);
  const tmp = new THREE.Color();
  for (let i = 0; i < pairs; i++) {
    const t = i / (pairs - 1);
    const a = t * Math.PI * 2 * turns;
    const y = (t - 0.5) * height;
    const p1 = new THREE.Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius);
    const p2 = new THREE.Vector3(-p1.x, y, -p1.z);
    const k = t * (palette.length - 1);
    tmp.copy(palette[Math.floor(k)]).lerp(palette[Math.min(palette.length - 1, Math.floor(k) + 1)], k % 1);
    balls.setMatrixAt(i * 2, m.compose(p1, q, s));
    balls.setMatrixAt(i * 2 + 1, m.compose(p2, q, s));
    balls.setColorAt(i * 2, tmp);
    balls.setColorAt(i * 2 + 1, tmp.clone().offsetHSL(0.08, 0, 0));
    const mid = p1.clone().add(p2).multiplyScalar(0.5);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a);
    rungs.setMatrixAt(i, m.compose(mid, q, new THREE.Vector3(radius * 2, 1, 1)));
    q.identity();
  }
  group.add(balls, rungs);
  group.userData.dispose = () => { ball.dispose(); rung.dispose(); balls.material.dispose(); rungs.material.dispose(); };
  return group;
}

/** A soft, round sprite for particles. */
function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createStarfield({ count = 1800, radius = 30, colors = ['#ffffff', '#ffb38a', '#b9a6ff'] } = {}) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const palette = colors.map((c) => new THREE.Color(c));
  for (let i = 0; i < count; i++) {
    const r = radius * (0.25 + Math.random() * 0.75);
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    pos.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.6, r * Math.sin(ph) * Math.sin(th)], i * 3);
    const c = palette[i % palette.length];
    col.set([c.r, c.g, c.b], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({ size: 0.12, map: dotTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.85 });
  return new THREE.Points(geo, mat);
}

// ---------------- the engine ----------------
export class Helix {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = { controls: true, bloom: false, autoRotate: false, fov: 45, maxPixelRatio: 2, camera: [0, 0, 6], environment: true, ...opts };
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.opts.maxPixelRatio));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.info.autoReset = false; // count every pass of a frame together
    this.scene = new THREE.Scene();
    if (this.opts.background) this.scene.background = new THREE.Color(this.opts.background);
    this.camera = new THREE.PerspectiveCamera(this.opts.fov, 1, 0.05, 200);
    this.camera.position.set(...this.opts.camera);
    this.clock = new THREE.Clock();
    this.time = 0;
    this.timeScale = reducedMotion() ? 0.25 : 1;
    this.materials = new Set();
    this.frameCallbacks = new Set();
    this.resolution = new THREE.Vector2();
    this.mouse = new THREE.Vector2(0.5, 0.5);
    this.pointer = new THREE.Vector2(0, 0); // -1..1, smoothed
    this.pointerTarget = new THREE.Vector2(0, 0);
    this.visible = true;
    this.running = false;

    if (this.opts.environment) {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
    }
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(3, 4, 5);
    this.scene.add(key);

    if (this.opts.controls) {
      this.controls = new OrbitControls(this.camera, canvas);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
      this.controls.enablePan = false;
      this.controls.minDistance = 2;
      this.controls.maxDistance = 20;
      this.controls.autoRotate = this.opts.autoRotate && !reducedMotion();
      this.controls.autoRotateSpeed = 1.2;
      if (this.opts.zoom === false) this.controls.enableZoom = false;
    }
    if (this.opts.bloom) this.enableBloom(this.opts.bloom === true ? {} : this.opts.bloom);

    this.onPointer = (e) => {
      const r = canvas.getBoundingClientRect();
      const x = (e.clientX - r.left) / Math.max(1, r.width);
      const y = (e.clientY - r.top) / Math.max(1, r.height);
      this.mouse.set(x, 1 - y);
      this.pointerTarget.set(x * 2 - 1, -(y * 2 - 1));
    };
    window.addEventListener('pointermove', this.onPointer, { passive: true });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.io = new IntersectionObserver(([entry]) => { this.visible = entry.isIntersecting; }, { threshold: 0 });
    this.io.observe(canvas);
    this.onVisibility = () => { if (document.hidden) this.clock.stop(); else this.clock.start(); };
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
  }

  enableBloom({ strength = 0.6, radius = 0.5, threshold = 0.55 } = {}) {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), strength, radius, threshold);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    for (const m of this.materials) m.setLinearOutput(true);
    this.resize();
    return this.bloom;
  }

  disableBloom() {
    if (!this.composer) return;
    this.composer.dispose();
    this.composer = null;
    this.bloom = null;
    for (const m of this.materials) m.setLinearOutput(false);
  }

  resize() {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.getDrawingBufferSize(this.resolution);
    if (this.composer) this.composer.setSize(w, h);
  }

  /** Create a live Pyre material that receives time/resolution/mouse automatically. */
  material(source, opts) {
    const m = new PyreMaterial(source, { linearOutput: !!this.composer, ...opts });
    this.materials.add(m);
    return m;
  }

  mesh(geometry, material) {
    const geo = typeof geometry === 'string' ? Models[geometry]() : geometry;
    return new THREE.Mesh(geo, material || new THREE.MeshStandardMaterial({ color: '#ff7a1a', roughness: 0.35, metalness: 0.2 }));
  }

  add(...objects) { this.scene.add(...objects); return objects[0]; }
  remove(...objects) { this.scene.remove(...objects); }

  /** Load a .glb/.gltf from a URL or a File, centred and scaled to fit a 3-unit box. */
  async load(input, { fit = 3, material } = {}) {
    const loader = new GLTFLoader();
    let gltf;
    if (typeof input === 'string') gltf = await loader.loadAsync(input);
    else {
      const buf = await input.arrayBuffer();
      gltf = await new Promise((resolve, reject) => loader.parse(buf, '', resolve, reject));
    }
    const root = gltf.scene;
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = fit / Math.max(size.x, size.y, size.z, 1e-6);
    root.position.sub(center.multiplyScalar(scale));
    root.scale.setScalar(scale);
    if (material) root.traverse((o) => { if (o.isMesh) o.material = material; });
    root.userData.animations = gltf.animations;
    return root;
  }

  onFrame(cb) { this.frameCallbacks.add(cb); return () => this.frameCallbacks.delete(cb); }

  renderFrame() {
    this.renderer.info.reset();
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.time += dt * this.timeScale;
    this.pointer.lerp(this.pointerTarget, 1 - Math.pow(0.001, dt));
    for (const cb of this.frameCallbacks) cb(this.time, dt);
    for (const m of this.materials) m.tick(this.time, this.resolution, this.mouse);
    if (this.controls) this.controls.update(dt);
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this.clock.start();
    this.renderer.setAnimationLoop(() => {
      if (!this.visible || document.hidden) return;
      this.renderFrame();
    });
    return this;
  }

  stop() {
    this.running = false;
    this.renderer.setAnimationLoop(null);
    return this;
  }

  screenshot(type = 'image/png') {
    this.renderFrame();
    return this.canvas.toDataURL(type);
  }

  dispose() {
    this.stop();
    window.removeEventListener('pointermove', this.onPointer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.resizeObserver.disconnect();
    this.io.disconnect();
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) [].concat(o.material).forEach((m) => m.dispose());
      if (o.userData.dispose) o.userData.dispose();
    });
    if (this.controls) this.controls.dispose();
    if (this.composer) this.composer.dispose();
    this.renderer.dispose();
  }
}

/** True when WebGL2 is available (Helix needs it). */
export function supported() {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

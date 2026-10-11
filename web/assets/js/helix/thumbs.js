// Renders model thumbnails with one shared WebGL context and copies them
// into lightweight 2D canvases. Work is time-sliced (a few ms per frame) and
// only visible cards are rendered, so scrolling stays smooth.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { build, FAMILY } from './catalog.js';

const HUES = { supershape: 0.78, knot: 0.05, harmonic: 0.55, lissajous: 0.92, superquadric: 0.12, shell: 0.09, surface: 0.6, polyhedron: 0.7, polytope: 0.75, duoprism: 0.85, clifford: 0.95, hypershape: 0.65, twisted: 0.02, spirograph: 0.5, lissajous4: 0.88 };

export class ThumbRenderer {
  constructor(size = 176) {
    this.size = size;
    this.canvas = document.createElement('canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(size, size, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(3, 4, 5);
    this.scene.add(key);
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 50);
    this.camera.position.set(3.3, 2.0, 4.3);
    this.camera.lookAt(0, 0, 0);
    this.material = new THREE.MeshStandardMaterial({ metalness: 0.45, roughness: 0.32 });
    this.queue = [];
    this.running = false;
  }

  /** Queue a model; `target` is a <canvas> that receives the image. */
  request(model, target) {
    if (target.dataset.done === model.id) return;
    this.queue.push({ model, target });
    if (!this.running) { this.running = true; requestAnimationFrame(() => this.pump()); }
  }

  cancel(target) { this.queue = this.queue.filter((j) => j.target !== target); }

  pump() {
    const t0 = performance.now();
    while (this.queue.length && performance.now() - t0 < 9) {
      const job = this.queue.shift();
      if (!job.target.isConnected) continue;
      try { this.render(job.model, job.target); } catch (err) { job.target.dataset.error = err.message; }
    }
    if (this.queue.length) requestAnimationFrame(() => this.pump());
    else this.running = false;
  }

  render(model, target) {
    const fam = FAMILY[model.family.id];
    this.material.color.setHSL(((HUES[fam.id] ?? 0.7) + ((model.index * 0.137) % 0.18)) % 1, 0.6, 0.6);
    const obj = build(fam.id, model.params, { quality: 'low', material: this.material });
    if (obj.isPolytope4D) {
      obj.angles.xw = 0.6; obj.angles.yw = 0.35; obj.angles.zw = 0.2;
      obj.scale3 = 2.5;
      obj.update(0);
    } else {
      obj.rotation.set(-0.25, 0.6, 0);
    }
    this.scene.add(obj);
    this.renderer.render(this.scene, this.camera);
    this.scene.remove(obj);
    if (obj.isPolytope4D) obj.dispose(); else obj.geometry.dispose();
    const ctx = target.getContext('2d');
    target.width = this.canvas.width;
    target.height = this.canvas.height;
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(this.canvas, 0, 0);
    target.dataset.done = model.id;
  }
}

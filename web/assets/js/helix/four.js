// Four-dimensional geometry for Helix: rotate 4D vertices in all six planes
// and project them into 3D (perspective from a 4D camera), every frame.
import * as THREE from 'three';

export const PLANES = ['xy', 'xz', 'xw', 'yz', 'yw', 'zw'];
const tmp = new THREE.Color();
const AXIS = { x: 0, y: 1, z: 2, w: 3 };

export class Polytope4D extends THREE.Group {
  constructor({ verts, edges, highlight = 0 }, { quality = 'high', colorA = '#ff7a1a', colorB = '#8b5cff', points = true } = {}) {
    super();
    this.isPolytope4D = true;
    this.count = verts.length;
    this.v4 = new Float32Array(verts.length * 4);
    verts.forEach((v, i) => this.v4.set(v, i * 4));
    // normalise to the unit 3-sphere so every shape projects at a similar size
    let max = 0;
    for (let i = 0; i < this.count; i++) max = Math.max(max, Math.hypot(this.v4[i * 4], this.v4[i * 4 + 1], this.v4[i * 4 + 2], this.v4[i * 4 + 3]));
    if (max > 0) for (let i = 0; i < this.v4.length; i++) this.v4[i] /= max;
    this.work = new Float32Array(this.v4.length);
    this.positions = new Float32Array(this.count * 3);
    this.colors = new Float32Array(this.count * 3);
    this.colorA = new THREE.Color(colorA);
    this.colorB = new THREE.Color(colorB);
    this.angles = Object.fromEntries(PLANES.map((p) => [p, 0]));
    this.speeds = { xy: 0, xz: 0.11, xw: 0.37, yz: 0, yw: 0.23, zw: 0.29 };
    this.distance = 2.4; // 4D camera distance on the w axis
    this.scale3 = 1.8;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    geo.setIndex(edges);
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, toneMapped: false }));
    this.add(this.lines);
    if (points && this.count <= 4000) {
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', geo.attributes.position);
      pg.setAttribute('color', geo.attributes.color);
      if (highlight) pg.setDrawRange(0, 0);
      this.points = new THREE.Points(pg, new THREE.PointsMaterial({ size: quality === 'low' ? 0.05 : 0.035, vertexColors: true, toneMapped: false }));
      this.add(this.points);
    }
    this.update(0);
  }

  /** Advance rotation by dt seconds (or set angles directly) and re-project. */
  update(dt = 0) {
    for (const p of PLANES) this.angles[p] += this.speeds[p] * dt;
    const w = this.work;
    w.set(this.v4);
    for (const p of PLANES) {
      const a = this.angles[p];
      if (!a) continue;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const i = AXIS[p[0]];
      const j = AXIS[p[1]];
      for (let k = 0; k < w.length; k += 4) {
        const x = w[k + i];
        const y = w[k + j];
        w[k + i] = c * x - s * y;
        w[k + j] = s * x + c * y;
      }
    }
    for (let v = 0; v < this.count; v++) {
      const k = v * 4;
      const f = (this.distance / (this.distance - w[k + 3])) * this.scale3 / 2;
      this.positions[v * 3] = w[k] * f;
      this.positions[v * 3 + 1] = w[k + 1] * f;
      this.positions[v * 3 + 2] = w[k + 2] * f;
      tmp.copy(this.colorB).lerp(this.colorA, (w[k + 3] + 1) / 2);
      this.colors[v * 3] = tmp.r;
      this.colors[v * 3 + 1] = tmp.g;
      this.colors[v * 3 + 2] = tmp.b;
    }
    const g = this.lines.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    g.computeBoundingSphere();
    return this;
  }

  dispose() {
    this.lines.geometry.dispose();
    this.lines.material.dispose();
    if (this.points) { this.points.geometry.dispose(); this.points.material.dispose(); }
  }
}

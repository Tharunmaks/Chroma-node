// Helix model catalog: 100,000+ procedurally generated 3D and 4D models.
// Every model has a stable id ("family/index") and parameters, so it can be
// opened, tweaked in the studio, saved and exported. Nothing is downloaded:
// geometry is generated on demand from the parameters.
import * as THREE from 'three';
import { Polytope4D } from './four.js';

const TAU = Math.PI * 2;
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const pick = (list, i) => list[((i % list.length) + list.length) % list.length];
const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));

/** Build an indexed surface from f(u, v) -> [x, y, z] over [0,1]². */
export function gridSurface(f, uSeg, vSeg) {
  const pos = new Float32Array((uSeg + 1) * (vSeg + 1) * 3);
  const uv = new Float32Array((uSeg + 1) * (vSeg + 1) * 2);
  let k = 0;
  for (let j = 0; j <= vSeg; j++) {
    for (let i = 0; i <= uSeg; i++) {
      const u = i / uSeg;
      const v = j / vSeg;
      const p = f(u, v);
      pos[k * 3] = Number.isFinite(p[0]) ? p[0] : 0;
      pos[k * 3 + 1] = Number.isFinite(p[1]) ? p[1] : 0;
      pos[k * 3 + 2] = Number.isFinite(p[2]) ? p[2] : 0;
      uv[k * 2] = u;
      uv[k * 2 + 1] = v;
      k++;
    }
  }
  const index = [];
  for (let j = 0; j < vSeg; j++) {
    for (let i = 0; i < uSeg; i++) {
      const a = j * (uSeg + 1) + i;
      const b = a + 1;
      const c = a + uSeg + 1;
      const d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** Centre a geometry and scale it to a bounding radius. */
export function normalize(g, radius = 1.45) {
  g.computeBoundingSphere();
  const { center, radius: r } = g.boundingSphere;
  if (!Number.isFinite(r) || r === 0) return g;
  g.translate(-center.x, -center.y, -center.z);
  g.scale(radius / r, radius / r, radius / r);
  g.computeBoundingSphere();
  return g;
}

// ---------------- 3D families ----------------
const SF_N = [0.25, 0.5, 1, 1.7, 3, 5, 9, 20];
const superformula = (t, m, n1, n2, n3) => {
  const a = Math.abs(Math.cos((m * t) / 4)) ** n2 + Math.abs(Math.sin((m * t) / 4)) ** n3;
  const r = a === 0 ? 0 : a ** (-1 / n1);
  return Math.min(r, 8);
};

const supershape = {
  id: 'supershape', name: 'Supershapes', dims: 3, count: 16 * 16 * 8 * 8,
  description: "Gielis' superformula in two directions: shells, stars, flowers and crystals.",
  params: [
    { key: 'm1', label: 'Symmetry (longitude)', min: 0, max: 30, step: 1 },
    { key: 'm2', label: 'Symmetry (latitude)', min: 0, max: 30, step: 1 },
    { key: 'n1', label: 'Roundness', min: 0.1, max: 30, step: 0.05 },
    { key: 'n2', label: 'Pinch', min: 0.1, max: 30, step: 0.05 },
  ],
  fromIndex: (i) => ({ m1: i % 16, m2: Math.floor(i / 16) % 16, n1: SF_N[Math.floor(i / 256) % 8], n2: SF_N[Math.floor(i / 2048) % 8] }),
  label: (p) => `m ${fmt(p.m1)}/${fmt(p.m2)} · n ${fmt(p.n1)}/${fmt(p.n2)}`,
  build(p, q) {
    const seg = q === 'low' ? 72 : 180;
    return gridSurface((u, v) => {
      const th = -Math.PI + u * TAU;
      const ph = -Math.PI / 2 + v * Math.PI;
      const r1 = superformula(th, p.m1, p.n1, p.n2, p.n2);
      const r2 = superformula(ph, p.m2, p.n1, p.n2, p.n2);
      return [r1 * Math.cos(th) * r2 * Math.cos(ph), r2 * Math.sin(ph), r1 * Math.sin(th) * r2 * Math.cos(ph)];
    }, seg, seg / 2);
  },
};

let knotPairs = null;
const pairs = () => {
  if (!knotPairs) {
    knotPairs = [];
    for (let p = 1; p <= 100; p++) for (let q = 1; q <= 100; q++) if (p !== q && gcd(p, q) === 1) knotPairs.push([p, q]);
  }
  return knotPairs;
};
const KNOT_STYLES = [
  { tube: 0.32, radial: 24, style: 'round' }, { tube: 0.18, radial: 16, style: 'thin' }, { tube: 0.4, radial: 3, style: 'triangular' },
  { tube: 0.36, radial: 4, style: 'square' }, { tube: 0.38, radial: 6, style: 'hexagonal' }, { tube: 0.1, radial: 12, style: 'wire' },
];
const torusKnot = {
  id: 'knot', name: 'Torus knots', dims: 3, count: pairs().length * 6,
  description: 'Every coprime (p, q) torus knot up to 100 windings, in six tube profiles.',
  params: [
    { key: 'p', label: 'Windings p', min: 1, max: 100, step: 1 },
    { key: 'q', label: 'Windings q', min: 1, max: 100, step: 1 },
    { key: 'tube', label: 'Tube radius', min: 0.03, max: 0.6, step: 0.01 },
    { key: 'radial', label: 'Tube sides', min: 3, max: 32, step: 1 },
  ],
  fromIndex(i) {
    const list = pairs();
    const [p, q] = list[Math.floor(i / 6) % list.length];
    const s = KNOT_STYLES[i % 6];
    return { p, q, tube: s.tube, radial: s.radial };
  },
  label: (p) => `(${p.p}, ${p.q}) · ${p.radial} sides`,
  build(p, q) {
    const complexity = Math.max(p.p, p.q);
    const tubular = Math.min(q === 'low' ? 600 : 2400, 64 + complexity * (q === 'low' ? 16 : 48));
    const tube = p.tube / Math.max(1, Math.sqrt(Math.min(p.p, p.q)) * 0.7);
    return new THREE.TorusKnotGeometry(1, tube, tubular, p.radial, p.p, p.q);
  },
};

// real spherical harmonics
function legendre(l, m, x) {
  let pmm = 1;
  if (m > 0) {
    const s = Math.sqrt((1 - x) * (1 + x));
    let f = 1;
    for (let i = 1; i <= m; i++) { pmm *= -f * s; f += 2; }
  }
  if (l === m) return pmm;
  let pmmp1 = x * (2 * m + 1) * pmm;
  if (l === m + 1) return pmmp1;
  let pll = 0;
  for (let ll = m + 2; ll <= l; ll++) {
    pll = ((2 * ll - 1) * x * pmmp1 - (ll + m - 1) * pmm) / (ll - m);
    pmm = pmmp1;
    pmmp1 = pll;
  }
  return pll;
}
function factorial(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }
export function sphericalHarmonic(l, m, theta, phi) {
  const am = Math.abs(m);
  const k = Math.sqrt(((2 * l + 1) / (4 * Math.PI)) * (factorial(l - am) / factorial(l + am)));
  const p = legendre(l, am, Math.cos(theta));
  if (m === 0) return k * p;
  return Math.SQRT2 * k * p * (m > 0 ? Math.cos(m * phi) : Math.sin(am * phi));
}
const LM = [];
for (let l = 0; l <= 7; l++) for (let m = -l; m <= l; m++) LM.push([l, m]);
const AMPS = [0.35, 0.7, 1.1];
const harmonics = {
  id: 'harmonic', name: 'Spherical harmonics', dims: 3, count: LM.length * LM.length * AMPS.length,
  description: 'Two superposed real spherical harmonics: the shapes of atomic orbitals, vibrating drums and planets.',
  params: [
    { key: 'l1', label: 'Degree l₁', min: 0, max: 12, step: 1 },
    { key: 'm1', label: 'Order m₁', min: -12, max: 12, step: 1 },
    { key: 'l2', label: 'Degree l₂', min: 0, max: 12, step: 1 },
    { key: 'm2', label: 'Order m₂', min: -12, max: 12, step: 1 },
    { key: 'amp', label: 'Amplitude', min: 0, max: 2, step: 0.01 },
  ],
  fromIndex(i) {
    const a = LM[i % LM.length];
    const b = LM[Math.floor(i / LM.length) % LM.length];
    return { l1: a[0], m1: a[1], l2: b[0], m2: b[1], amp: AMPS[Math.floor(i / (LM.length * LM.length)) % 3] };
  },
  label: (p) => `Y(${p.l1},${p.m1}) + Y(${p.l2},${p.m2})`,
  build(p, q) {
    const seg = q === 'low' ? 64 : 160;
    const m1 = Math.max(-p.l1, Math.min(p.l1, p.m1));
    const m2 = Math.max(-p.l2, Math.min(p.l2, p.m2));
    const vals = [];
    let max = 1e-6;
    for (let j = 0; j <= seg / 2; j++) for (let i = 0; i <= seg; i++) {
      const th = (j / (seg / 2)) * Math.PI;
      const ph = (i / seg) * TAU;
      const y = sphericalHarmonic(p.l1, m1, th, ph) + sphericalHarmonic(p.l2, m2, th, ph);
      vals.push(y);
      max = Math.max(max, Math.abs(y));
    }
    let k = 0;
    return gridSurface((u, v) => {
      const th = v * Math.PI;
      const ph = u * TAU;
      const r = Math.max(0.05, 1 + (p.amp * vals[k++]) / max);
      return [r * Math.sin(th) * Math.cos(ph), r * Math.cos(th), r * Math.sin(th) * Math.sin(ph)];
    }, seg, seg / 2);
  },
};

class LissajousCurve extends THREE.Curve {
  constructor(a, b, c) { super(); Object.assign(this, { a, b, c }); }
  getPoint(t, target = new THREE.Vector3()) {
    const s = t * TAU;
    return target.set(Math.cos(this.a * s + 0.7), Math.cos(this.b * s + 0.2), Math.cos(this.c * s));
  }
}
const lissajous = {
  id: 'lissajous', name: 'Lissajous knots', dims: 3, count: 28 ** 3,
  description: 'Closed curves from three harmonic oscillations, swept into tubes.',
  params: [
    { key: 'a', label: 'Frequency x', min: 1, max: 40, step: 1 },
    { key: 'b', label: 'Frequency y', min: 1, max: 40, step: 1 },
    { key: 'c', label: 'Frequency z', min: 1, max: 40, step: 1 },
    { key: 'tube', label: 'Tube radius', min: 0.01, max: 0.2, step: 0.005 },
  ],
  fromIndex: (i) => ({ a: (i % 28) + 1, b: (Math.floor(i / 28) % 28) + 1, c: (Math.floor(i / 784) % 28) + 1, tube: 0.05 }),
  label: (p) => `(${p.a}, ${p.b}, ${p.c})`,
  build(p, q) {
    const n = Math.min(q === 'low' ? 700 : 3000, 120 + (p.a + p.b + p.c) * (q === 'low' ? 10 : 40));
    return new THREE.TubeGeometry(new LissajousCurve(p.a, p.b, p.c), n, p.tube, q === 'low' ? 6 : 12, true);
  },
};

const EXPS = Array.from({ length: 40 }, (_, i) => +(0.1 * Math.pow(40, i / 39)).toFixed(3));
const sgnPow = (x, e) => Math.sign(x) * Math.abs(x) ** e;
const superquadric = {
  id: 'superquadric', name: 'Superquadrics', dims: 3, count: 40 * 40 * 2,
  description: 'Superellipsoids and supertoroids: from cubes and cushions to stars and pillows.',
  params: [
    { key: 'e1', label: 'Vertical exponent', min: 0.05, max: 4, step: 0.01 },
    { key: 'e2', label: 'Horizontal exponent', min: 0.05, max: 4, step: 0.01 },
    { key: 'torus', label: 'Torus (0 = solid)', min: 0, max: 1, step: 1 },
  ],
  fromIndex: (i) => ({ e1: EXPS[i % 40], e2: EXPS[Math.floor(i / 40) % 40], torus: Math.floor(i / 1600) % 2 }),
  label: (p) => `${p.torus ? 'toroid' : 'ellipsoid'} ${fmt(p.e1)}/${fmt(p.e2)}`,
  build(p, q) {
    const seg = q === 'low' ? 64 : 160;
    return gridSurface((u, v) => {
      const w = -Math.PI + u * TAU;
      if (p.torus) {
        const e = -Math.PI + v * TAU;
        const r = 1 + 0.45 * sgnPow(Math.cos(e), p.e1);
        return [r * sgnPow(Math.cos(w), p.e2), 0.45 * sgnPow(Math.sin(e), p.e1), r * sgnPow(Math.sin(w), p.e2)];
      }
      const e = -Math.PI / 2 + v * Math.PI;
      const ce = sgnPow(Math.cos(e), p.e1);
      return [ce * sgnPow(Math.cos(w), p.e2), sgnPow(Math.sin(e), p.e1), ce * sgnPow(Math.sin(w), p.e2)];
    }, seg, p.torus ? seg : seg / 2);
  },
};

const FLARES = [1.05, 1.1, 1.15, 1.2, 1.28, 1.36, 1.45, 1.6];
const shells = {
  id: 'shell', name: 'Seashells', dims: 3, count: 11 * 8 * 16,
  description: 'Logarithmic spiral shells with ribs, from tight cones to wide nautilus whorls.',
  params: [
    { key: 'coils', label: 'Coils', min: 1, max: 14, step: 0.1 },
    { key: 'flare', label: 'Flare', min: 1.01, max: 2, step: 0.01 },
    { key: 'ribs', label: 'Ribs', min: 0, max: 40, step: 1 },
  ],
  fromIndex: (i) => ({ coils: 2 + (i % 11), flare: FLARES[Math.floor(i / 11) % 8], ribs: Math.floor(i / 88) % 16 }),
  label: (p) => `${fmt(p.coils)} coils · flare ${fmt(p.flare)} · ${p.ribs} ribs`,
  build(p, q) {
    const seg = q === 'low' ? 96 : 300;
    const growth = Math.log(p.flare);
    return gridSurface((u, v) => {
      const s = u * p.coils * TAU;
      const t = v * TAU;
      const R = Math.exp(growth * s * 0.5) * 0.15;
      const rib = 1 + 0.08 * Math.sin(p.ribs * s) * (p.ribs ? 1 : 0);
      const r = R * 0.55 * rib;
      const x = (R + r * Math.cos(t)) * Math.cos(s);
      const z = (R + r * Math.cos(t)) * Math.sin(s);
      const y = -R * 1.6 + r * Math.sin(t);
      return [x, y, z];
    }, seg, q === 'low' ? 24 : 48);
  },
};

const CLASSICS = {
  'Klein bottle': (u, v) => {
    const U = u * TAU, V = v * TAU;
    const r = 4 * (1 - Math.cos(U) / 2);
    if (U < Math.PI) return [6 * Math.cos(U) * (1 + Math.sin(U)) + r * Math.cos(U) * Math.cos(V), 16 * Math.sin(U) + r * Math.sin(U) * Math.cos(V), r * Math.sin(V)];
    return [6 * Math.cos(U) * (1 + Math.sin(U)) + r * Math.cos(V + Math.PI), 16 * Math.sin(U), r * Math.sin(V)];
  },
  'Möbius strip': (u, v) => { const U = u * TAU, V = v - 0.5; return [(1 + V / 2 * Math.cos(U / 2)) * Math.cos(U), V / 2 * Math.sin(U / 2), (1 + V / 2 * Math.cos(U / 2)) * Math.sin(U)]; },
  'Enneper surface': (u, v) => { const U = (u - 0.5) * 4, V = (v - 0.5) * 4; return [U - U ** 3 / 3 + U * V * V, U * U - V * V, V - V ** 3 / 3 + V * U * U]; },
  Catenoid: (u, v) => { const U = u * TAU, V = (v - 0.5) * 3; return [Math.cosh(V) * Math.cos(U), V, Math.cosh(V) * Math.sin(U)]; },
  Helicoid: (u, v) => { const U = (u - 0.5) * 4, V = v * 4 * Math.PI; return [U * Math.cos(V), V * 0.3, U * Math.sin(V)]; },
  "Dini's surface": (u, v) => { const U = u * 4 * Math.PI, V = 0.01 + v * 1.9; return [Math.cos(U) * Math.sin(V), Math.cos(V) + Math.log(Math.tan(V / 2)) + 0.2 * U, Math.sin(U) * Math.sin(V)]; },
  "Boy's surface": (u, v) => {
    const U = u * Math.PI, V = v * Math.PI;
    const a = Math.cos(V), b = Math.sin(V);
    const x = (Math.SQRT2 * a * a * Math.cos(2 * U) + Math.cos(U) * Math.sin(2 * V)) / (2 - Math.SQRT2 * Math.sin(3 * U) * Math.sin(2 * V));
    const y = (Math.SQRT2 * a * a * Math.sin(2 * U) - Math.sin(U) * Math.sin(2 * V)) / (2 - Math.SQRT2 * Math.sin(3 * U) * Math.sin(2 * V));
    const z = (3 * a * a) / (2 - Math.SQRT2 * Math.sin(3 * U) * Math.sin(2 * V));
    return [x, z, y];
  },
  'Breather surface': (u, v) => {
    const U = (u - 0.5) * 28, V = (v - 0.5) * 75;
    const a = 0.4, w = Math.sqrt(1 - a * a);
    const d = a * ((w * Math.cosh(a * U)) ** 2 + (a * Math.sin(w * V)) ** 2);
    return [-U + (2 * w * w * Math.cosh(a * U) * Math.sinh(a * U)) / d, (2 * w * Math.cosh(a * U) * (-(w * Math.cos(V) * Math.cos(w * V)) - Math.sin(V) * Math.sin(w * V))) / d, (2 * w * Math.cosh(a * U) * (-(w * Math.sin(V) * Math.cos(w * V)) + Math.cos(V) * Math.sin(w * V))) / d];
  },
  'Trefoil tube': (u, v) => {
    const U = u * TAU, V = v * TAU;
    const c = [Math.sin(U) + 2 * Math.sin(2 * U), Math.cos(U) - 2 * Math.cos(2 * U), -Math.sin(3 * U)];
    return [c[0] + 0.5 * Math.cos(V) * Math.cos(U), c[1] + 0.5 * Math.cos(V) * Math.sin(U), c[2] + 0.5 * Math.sin(V)];
  },
  'Spring': (u, v) => { const U = u * 10 * Math.PI, V = v * TAU; return [(1 + 0.25 * Math.cos(V)) * Math.cos(U), 0.15 * U + 0.25 * Math.sin(V), (1 + 0.25 * Math.cos(V)) * Math.sin(U)]; },
  'Hyperbolic paraboloid': (u, v) => { const U = (u - 0.5) * 2, V = (v - 0.5) * 2; return [U, U * U - V * V, V]; },
  'Cross-cap': (u, v) => { const U = u * TAU, V = v * Math.PI / 2; return [Math.cos(U) * Math.sin(2 * V), Math.sin(U) * Math.sin(2 * V), Math.cos(V) ** 2 - (Math.cos(U) * Math.sin(V)) ** 2]; },
};
const CLASSIC_NAMES = Object.keys(CLASSICS);
const surfaces = {
  id: 'surface', name: 'Classic surfaces', dims: 3, count: CLASSIC_NAMES.length,
  description: 'Famous mathematical surfaces: Klein bottle, Möbius strip, Boy\'s surface and more.',
  params: [{ key: 'kind', label: 'Surface', min: 0, max: CLASSIC_NAMES.length - 1, step: 1, options: CLASSIC_NAMES }],
  fromIndex: (i) => ({ kind: i % CLASSIC_NAMES.length }),
  label: (p) => CLASSIC_NAMES[p.kind],
  build: (p, q) => gridSurface(CLASSICS[CLASSIC_NAMES[p.kind]], q === 'low' ? 80 : 220, q === 'low' ? 40 : 110),
};

const SOLIDS = ['Tetrahedron', 'Octahedron', 'Icosahedron', 'Dodecahedron', 'Cube'];
const SPIKES = [0, 0.15, 0.3, 0.5, 0.8, 1.2];
const polyhedra = {
  id: 'polyhedron', name: 'Polyhedra', dims: 3, count: SOLIDS.length * 6 * SPIKES.length,
  description: 'Platonic solids, geodesic subdivisions and stellations.',
  params: [
    { key: 'solid', label: 'Solid', min: 0, max: 4, step: 1, options: SOLIDS },
    { key: 'detail', label: 'Subdivision', min: 0, max: 6, step: 1 },
    { key: 'spike', label: 'Stellation', min: 0, max: 2, step: 0.01 },
  ],
  fromIndex: (i) => ({ solid: i % 5, detail: Math.floor(i / 5) % 6, spike: SPIKES[Math.floor(i / 30) % 6] }),
  label: (p) => `${SOLIDS[p.solid]} · detail ${p.detail}${p.spike ? ` · spikes ${fmt(p.spike)}` : ''}`,
  build(p) {
    const r = 1;
    const base = [
      () => new THREE.TetrahedronGeometry(r, p.detail), () => new THREE.OctahedronGeometry(r, p.detail),
      () => new THREE.IcosahedronGeometry(r, p.detail), () => new THREE.DodecahedronGeometry(r, p.detail),
      () => new THREE.BoxGeometry(1.2, 1.2, 1.2, p.detail + 1, p.detail + 1, p.detail + 1).toNonIndexed(),
    ][p.solid]();
    if (!p.spike) { base.computeVertexNormals(); return base; }
    const src = base.attributes.position.array;
    const out = new Float32Array(src.length * 3);
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), M = new THREE.Vector3();
    for (let t = 0, o = 0; t < src.length; t += 9) {
      A.fromArray(src, t); B.fromArray(src, t + 3); C.fromArray(src, t + 6);
      M.copy(A).add(B).add(C).divideScalar(3);
      const n = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3().subVectors(C, A)).normalize();
      const edge = A.distanceTo(B);
      M.addScaledVector(n, p.spike * edge * 1.2);
      for (const [x, y] of [[A, B], [B, C], [C, A]]) { x.toArray(out, o); y.toArray(out, o + 3); M.toArray(out, o + 6); o += 9; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(out, 3));
    g.computeVertexNormals();
    base.dispose();
    return g;
  },
};

// ---------------- 4D families (rendered by Polytope4D) ----------------
const PHI = (1 + Math.sqrt(5)) / 2;
function edgesByDistance(verts, tol = 1e-3) {
  let min = Infinity;
  const n = verts.length;
  for (let j = 1; j < n; j++) {
    const d = dist4(verts[0], verts[j]);
    if (d > tol && d < min) min = d;
  }
  const edges = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (Math.abs(dist4(verts[i], verts[j]) - min) < tol * 10) edges.push(i, j);
  return edges;
}
const dist4 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]);
function signs(v) {
  const out = [[]];
  for (const x of v) {
    const next = [];
    for (const o of out) { if (x === 0) next.push([...o, 0]); else next.push([...o, x], [...o, -x]); }
    out.splice(0, out.length, ...next);
  }
  return out;
}
function permutations(a, evenOnly = false) {
  const res = [];
  const permute = (arr, k, parity) => {
    if (k === arr.length) { if (!evenOnly || parity === 0) res.push(arr.slice()); return; }
    for (let i = k; i < arr.length; i++) {
      [arr[k], arr[i]] = [arr[i], arr[k]];
      permute(arr, k + 1, i === k ? parity : 1 - parity);
      [arr[k], arr[i]] = [arr[i], arr[k]];
    }
  };
  permute(a.slice(), 0, 0);
  return res;
}
function uniq(vs) {
  const seen = new Map();
  for (const v of vs) seen.set(v.map((x) => x.toFixed(5)).join(','), v);
  return [...seen.values()];
}
const POLYTOPES = {
  '5-cell (simplex)': () => {
    const v = [[1, 1, 1, -1 / Math.sqrt(5)], [1, -1, -1, -1 / Math.sqrt(5)], [-1, 1, -1, -1 / Math.sqrt(5)], [-1, -1, 1, -1 / Math.sqrt(5)], [0, 0, 0, 4 / Math.sqrt(5)]];
    return { verts: v, edges: [0, 1, 0, 2, 0, 3, 0, 4, 1, 2, 1, 3, 1, 4, 2, 3, 2, 4, 3, 4] };
  },
  'Tesseract (8-cell)': () => { const v = signs([1, 1, 1, 1]); return { verts: v, edges: edgesByDistance(v) }; },
  '16-cell': () => { const v = uniq(permutations([1, 0, 0, 0]).flatMap(signs)); return { verts: v, edges: edgesByDistance(v) }; },
  '24-cell': () => { const v = uniq(permutations([1, 1, 0, 0]).flatMap(signs)); return { verts: v, edges: edgesByDistance(v) }; },
  '600-cell': () => {
    const v = uniq([
      ...permutations([1, 0, 0, 0]).flatMap(signs),
      ...signs([0.5, 0.5, 0.5, 0.5]),
      ...permutations([PHI / 2, 0.5, 1 / (2 * PHI), 0], true).flatMap(signs),
    ]);
    return { verts: v, edges: edgesByDistance(v) };
  },
  '120-cell': () => {
    // dual of the 600-cell: one vertex per tetrahedral cell, joined across shared faces
    const { verts, edges } = POLYTOPES['600-cell']();
    const adj = verts.map(() => new Set());
    for (let i = 0; i < edges.length; i += 2) { adj[edges[i]].add(edges[i + 1]); adj[edges[i + 1]].add(edges[i]); }
    const cells = [];
    for (let a = 0; a < verts.length; a++) for (const b of adj[a]) if (b > a) for (const c of adj[a]) if (c > b && adj[b].has(c)) for (const d of adj[a]) if (d > c && adj[b].has(d) && adj[c].has(d)) cells.push([a, b, c, d]);
    const centers = cells.map((c) => [0, 1, 2, 3].map((k) => c.reduce((s, i) => s + verts[i][k], 0) / 4));
    const faceMap = new Map();
    const out = [];
    cells.forEach((c, ci) => {
      for (let skip = 0; skip < 4; skip++) {
        const key = c.filter((_, k) => k !== skip).join(',');
        if (faceMap.has(key)) out.push(faceMap.get(key), ci);
        else faceMap.set(key, ci);
      }
    });
    return { verts: centers, edges: out };
  },
};
const POLYTOPE_NAMES = Object.keys(POLYTOPES);
const polytopes = {
  id: 'polytope', name: 'Regular 4D polytopes', dims: 4, count: POLYTOPE_NAMES.length,
  description: 'All six convex regular 4-polytopes, from the 5-cell to the 120-cell (600 vertices).',
  params: [{ key: 'kind', label: 'Polytope', min: 0, max: 5, step: 1, options: POLYTOPE_NAMES }],
  fromIndex: (i) => ({ kind: i % 6 }),
  label: (p) => POLYTOPE_NAMES[p.kind],
  build4: (p) => POLYTOPES[POLYTOPE_NAMES[p.kind]](),
};

const duoprisms = {
  id: 'duoprism', name: '4D duoprisms', dims: 4, count: 78 * 78,
  description: 'The Cartesian product of a p-gon and a q-gon: a 4D shape with p·q vertices.',
  params: [
    { key: 'p', label: 'Polygon p', min: 3, max: 120, step: 1 },
    { key: 'q', label: 'Polygon q', min: 3, max: 120, step: 1 },
  ],
  fromIndex: (i) => ({ p: 3 + (i % 78), q: 3 + (Math.floor(i / 78) % 78) }),
  label: (p) => `${p.p}-${p.q} duoprism`,
  build4(p) {
    const verts = [];
    const edges = [];
    for (let i = 0; i < p.p; i++) for (let j = 0; j < p.q; j++) {
      const a = (i / p.p) * TAU;
      const b = (j / p.q) * TAU;
      verts.push([Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)]);
      const k = i * p.q + j;
      edges.push(k, ((i + 1) % p.p) * p.q + j, k, i * p.q + ((j + 1) % p.q));
    }
    return { verts, edges };
  },
};

const clifford = {
  id: 'clifford', name: '4D Clifford torus knots', dims: 4, count: 60 * 60,
  description: 'Curves winding p and q times around the flat Clifford torus in four dimensions.',
  params: [
    { key: 'p', label: 'Windings p', min: 1, max: 80, step: 1 },
    { key: 'q', label: 'Windings q', min: 1, max: 80, step: 1 },
    { key: 'grid', label: 'Torus grid lines', min: 0, max: 32, step: 1 },
  ],
  fromIndex: (i) => ({ p: 1 + (i % 60), q: 1 + (Math.floor(i / 60) % 60), grid: 12 }),
  label: (p) => `(${p.p}, ${p.q}) on the Clifford torus`,
  build4(p) {
    const verts = [];
    const edges = [];
    const n = Math.min(4000, 200 + 40 * (p.p + p.q));
    for (let i = 0; i < n; i++) {
      const t = (i / n) * TAU;
      verts.push([Math.cos(p.p * t), Math.sin(p.p * t), Math.cos(p.q * t), Math.sin(p.q * t)]);
      edges.push(i, (i + 1) % n);
    }
    // faint torus grid
    const g = p.grid;
    for (let a = 0; a < g; a++) {
      const base = verts.length;
      const seg = 48;
      for (let s = 0; s < seg; s++) {
        const u = (a / g) * TAU;
        const v = (s / seg) * TAU;
        verts.push([Math.cos(u), Math.sin(u), Math.cos(v), Math.sin(v)]);
        edges.push(base + s, base + ((s + 1) % seg));
      }
    }
    return { verts, edges, highlight: n };
  },
};

const hyperSuper = {
  id: 'hypershape', name: '4D supershapes', dims: 4, count: 20 * 20 * 20,
  description: 'The superformula applied on the 3-sphere: hyper-flowers and hyper-stars in four dimensions.',
  params: [
    { key: 'm1', label: 'Symmetry 1', min: 0, max: 30, step: 1 },
    { key: 'm2', label: 'Symmetry 2', min: 0, max: 30, step: 1 },
    { key: 'm3', label: 'Symmetry 3', min: 0, max: 30, step: 1 },
    { key: 'n', label: 'Roundness', min: 0.2, max: 20, step: 0.1 },
  ],
  fromIndex: (i) => ({ m1: i % 20, m2: Math.floor(i / 20) % 20, m3: Math.floor(i / 400) % 20, n: 1.5 }),
  label: (p) => `m ${p.m1}/${p.m2}/${p.m3}`,
  build4(p) {
    const verts = [];
    const edges = [];
    const R = 18;
    const S = 40;
    const idx = (i, j, k) => (i * S + j) * R + k;
    for (let i = 0; i < 6; i++) {
      const eta = ((i + 0.5) / 6) * (Math.PI / 2);
      for (let j = 0; j < S; j++) for (let k = 0; k < R; k++) {
        const x1 = (j / S) * TAU;
        const x2 = (k / R) * TAU;
        const r = superformula(x1, p.m1, p.n, p.n, p.n) * superformula(x2, p.m2, p.n, p.n, p.n) * superformula(eta * 4, p.m3, p.n, p.n, p.n);
        verts.push([r * Math.cos(eta) * Math.cos(x1), r * Math.cos(eta) * Math.sin(x1), r * Math.sin(eta) * Math.cos(x2), r * Math.sin(eta) * Math.sin(x2)]);
      }
    }
    for (let i = 0; i < 6; i++) for (let j = 0; j < S; j++) for (let k = 0; k < R; k++) {
      edges.push(idx(i, j, k), idx(i, (j + 1) % S, k), idx(i, j, k), idx(i, j, (k + 1) % R));
    }
    return { verts, edges };
  },
};

export const FAMILIES = [supershape, torusKnot, harmonics, lissajous, superquadric, shells, surfaces, polyhedra, polytopes, duoprisms, clifford, hyperSuper];
export const FAMILY = Object.fromEntries(FAMILIES.map((f) => [f.id, f]));
export const TOTAL = FAMILIES.reduce((s, f) => s + f.count, 0);
export const TOTAL_3D = FAMILIES.filter((f) => f.dims === 3).reduce((s, f) => s + f.count, 0);
export const TOTAL_4D = TOTAL - TOTAL_3D;

/** Model descriptor for "family/index" or a global index. */
export function get(ref) {
  let fam;
  let i;
  if (typeof ref === 'number') {
    let n = ((ref % TOTAL) + TOTAL) % TOTAL;
    fam = FAMILIES.find((f) => { if (n < f.count) return true; n -= f.count; return false; });
    i = n;
  } else {
    const [fid, idx] = String(ref).split('/');
    fam = FAMILY[fid];
    i = Number(idx);
    if (!fam || !Number.isInteger(i) || i < 0 || i >= fam.count) return null;
  }
  const params = fam.fromIndex(i);
  return { id: `${fam.id}/${i}`, family: fam, index: i, params, name: `${fam.name.replace(/s$/, '')} #${i}`, label: fam.label(params) };
}

/** A global index for a family-relative index (used for paging through everything). */
export function globalIndex(familyId, i) {
  let off = 0;
  for (const f of FAMILIES) { if (f.id === familyId) return off + i; off += f.count; }
  return -1;
}

/**
 * Build a renderable object. 3D families return a Mesh; 4D families return a
 * Polytope4D (call .update(t) every frame to rotate it through 4D).
 */
export function build(familyId, params, { quality = 'high', material } = {}) {
  const fam = FAMILY[familyId];
  if (!fam) throw new Error(`unknown model family ${familyId}`);
  if (fam.dims === 4) return new Polytope4D(fam.build4(params), { quality });
  const geo = normalize(fam.build(params, quality));
  return new THREE.Mesh(geo, material || new THREE.MeshStandardMaterial({ color: '#d9d2ff', metalness: 0.35, roughness: 0.35 }));
}

/** Deterministic pseudo-random model, handy for "surprise me". */
export function random(seed = Math.random()) { return get(Math.floor(seed * TOTAL)); }

/**
 * Search: words match family names/descriptions, numbers match parameter
 * values in labels ("knot 3 5" finds the (3,5) torus knots). An exact id
 * like "duoprism/42" jumps straight to that model.
 */
export function search(query, { limit = 60, family, offset = 0 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (q.includes('/')) { const d = get(q); return d ? [d] : []; }
  const tokens = q.split(/[\s,()]+/).filter(Boolean);
  const words = tokens.filter((t) => !/^-?\d+(\.\d+)?$/.test(t));
  const nums = tokens.filter((t) => /^-?\d+(\.\d+)?$/.test(t));
  const fams = FAMILIES.filter((f) => (!family || f.id === family)
    && words.every((w) => `${f.id} ${f.name} ${f.description} ${f.dims}d`.toLowerCase().includes(w.replace(/s$/, ''))));
  const out = [];
  let skipped = 0;
  for (const f of fams) {
    for (let i = 0; i < f.count && out.length < limit; i++) {
      if (nums.length) {
        const parts = f.label(f.fromIndex(i)).toLowerCase().split(/[^0-9.]+/);
        if (!nums.every((n) => parts.includes(n))) continue;
      }
      if (skipped++ < offset) continue;
      out.push(get(`${f.id}/${i}`));
    }
    if (out.length >= limit) break;
  }
  return out;
}

/** Geometry from a (n+1)·(m+1) grid of points (used by Pyre-defined models). */
export function fromGrid(positions, n, m, dims = 3) {
  const pts = [];
  for (let k = 0; k < (n + 1) * (m + 1); k++) pts.push(Array.from(positions.subarray(k * dims, k * dims + dims)));
  if (dims === 4) {
    const edges = [];
    for (let j = 0; j <= m; j++) for (let i = 0; i <= n; i++) {
      const a = j * (n + 1) + i;
      if (i < n) edges.push(a, a + 1);
      if (j < m && i % Math.max(1, Math.round(n / 24)) === 0) edges.push(a, a + n + 1);
    }
    return new Polytope4D({ verts: pts, edges }, { points: false });
  }
  let k = 0;
  return new THREE.Mesh(normalize(gridSurface(() => pts[k++], n, m)));
}

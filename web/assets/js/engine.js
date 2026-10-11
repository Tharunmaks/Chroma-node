// Helix studio: switch scenes, materials and models; load your own glTF.
import { $, $$, h, toast } from './common.js';
import { Helix, Models, THREE, createDNA, createStarfield, supported } from 'helix';
import { SHADERS } from './shaders.js';

if (!supported()) {
  $('#studio').replaceChildren(h('div', { class: 'empty' }, 'WebGL2 is not available in this browser, so the studio cannot run.'));
} else {
  const engine = new Helix($('#studio canvas'), { bloom: { strength: 0.6, radius: 0.5, threshold: 0.55 }, autoRotate: true, camera: [0, 0.4, 5.4] });
  const stars = createStarfield({ count: 1200, radius: 24 });
  engine.add(stars);

  const PBR = {
    chrome: { name: 'Chrome (PBR)', make: () => new THREE.MeshPhysicalMaterial({ color: '#ffffff', metalness: 1, roughness: 0.06, clearcoat: 1 }) },
    glass: { name: 'Frosted glass (PBR)', make: () => new THREE.MeshPhysicalMaterial({ color: '#cfc4ff', metalness: 0, roughness: 0.25, transmission: 0.9, thickness: 1.2, ior: 1.4 }) },
  };
  const pyreKeys = Object.keys(SHADERS).filter((k) => SHADERS[k].model !== 'plane');
  const matSel = $('#mat');
  matSel.append(
    h('optgroup', { label: 'Pyre (compiled live)' }, ...pyreKeys.map((k) => h('option', { value: `pyre:${k}` }, SHADERS[k].name))),
    h('optgroup', { label: 'Physically based' }, ...Object.entries(PBR).map(([k, v]) => h('option', { value: `pbr:${k}` }, v.name))),
  );
  const pyreMat = engine.material(SHADERS.iridescent.source);
  let speed = 1;
  let scene = null;

  function currentMaterial() {
    const [kind, key] = matSel.value.split(':');
    if (kind === 'pbr') return PBR[key].make();
    pyreMat.initial = SHADERS[key].uniforms || {};
    pyreMat.setSource(SHADERS[key].source);
    for (const [k, v] of Object.entries(pyreMat.initial)) pyreMat.set(k, v);
    $('#edit-link').href = `/playground#example=s:${key}`;
    return pyreMat;
  }

  const SCENES = {
    Showcase() {
      const g = new THREE.Group();
      const hero = engine.mesh(Models[$('#geo').value](), currentMaterial());
      if ($('#geo').value === 'helix') hero.scale.setScalar(0.8);
      const dna = createDNA({ pairs: 40, height: 9, radius: 1.1, turns: 3 });
      dna.position.set(-3.2, 0, -3);
      dna.rotation.z = 0.4;
      g.add(hero, dna);
      return { object: g, tick: (t) => { hero.rotation.y = t * 0.5 * speed; hero.rotation.x = t * 0.2 * speed; dna.rotation.y = t * 0.3 * speed; } };
    },
    'Instanced field'() {
      const count = 24 * 24;
      const mesh = new THREE.InstancedMesh(Models.crystal(), new THREE.MeshStandardMaterial({ metalness: 0.7, roughness: 0.2, flatShading: true }), count);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      const p = new THREE.Vector3();
      const color = new THREE.Color();
      for (let i = 0; i < count; i++) mesh.setColorAt(i, color.setHSL(0.72 + (i % 24) / 24 * 0.25, 0.8, 0.6));
      return {
        object: mesh,
        tick: (t) => {
          for (let i = 0; i < count; i++) {
            const x = (i % 24) - 11.5;
            const z = Math.floor(i / 24) - 11.5;
            const d = Math.hypot(x, z);
            const y = Math.sin(d * 0.6 - t * 2 * speed) * 0.6;
            p.set(x * 0.32, y - 0.6, z * 0.32);
            q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t * speed + d * 0.2);
            s.setScalar(0.09 + 0.05 * (y + 0.6));
            mesh.setMatrixAt(i, m.compose(p, q, s));
          }
          mesh.instanceMatrix.needsUpdate = true;
        },
      };
    },
    'Orbit system'() {
      const g = new THREE.Group();
      const core = engine.mesh(Models.sphere(), currentMaterial());
      core.scale.setScalar(0.7);
      g.add(core);
      const moons = [];
      for (let i = 0; i < 5; i++) {
        const moon = new THREE.Mesh(Models.icosahedron(1), new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(i / 5, 0.7, 0.6), metalness: 0.3, roughness: 0.3, flatShading: true }));
        moon.scale.setScalar(0.12 + i * 0.03);
        moon.userData = { r: 1.6 + i * 0.45, s: 0.9 - i * 0.12, tilt: (i - 2) * 0.18 };
        const ring = new THREE.Mesh(new THREE.TorusGeometry(moon.userData.r, 0.004, 6, 160), new THREE.MeshBasicMaterial({ color: '#8b5cff', transparent: true, opacity: 0.35 }));
        ring.rotation.x = Math.PI / 2 + moon.userData.tilt;
        g.add(moon, ring);
        moons.push(moon);
      }
      return {
        object: g,
        tick: (t) => {
          core.rotation.y = t * 0.3 * speed;
          for (const m of moons) {
            const a = t * m.userData.s * speed;
            m.position.set(Math.cos(a) * m.userData.r, Math.sin(a) * m.userData.r * Math.sin(m.userData.tilt), Math.sin(a) * m.userData.r);
            m.rotation.y = t;
          }
        },
      };
    },
  };

  function show(name, custom) {
    if (scene) {
      engine.remove(scene.object);
      scene.object.traverse((o) => { if (o.geometry && !o.userData.keep) o.geometry.dispose(); });
    }
    scene = custom || SCENES[name]();
    engine.add(scene.object);
    for (const c of $$('#scenes .chip')) c.setAttribute('aria-pressed', String(c.dataset.k === name));
  }
  const current = () => $('#scenes .chip[aria-pressed="true"]')?.dataset.k || 'Showcase';
  for (const name of Object.keys(SCENES)) $('#scenes').append(h('button', { class: 'chip', 'data-k': name, 'aria-pressed': 'false', onclick: () => show(name) }, name));

  engine.onFrame((t) => scene && scene.tick && scene.tick(t));
  matSel.addEventListener('change', () => { if (current() !== 'Your model') show(current()); });
  $('#geo').addEventListener('change', () => show('Showcase'));
  $('#bloom').addEventListener('input', (e) => { if (engine.bloom) engine.bloom.strength = Number(e.target.value); });
  $('#speed').addEventListener('input', (e) => { speed = Number(e.target.value); engine.controls.autoRotateSpeed = 1.2 * speed; });
  $('#shot').addEventListener('click', () => h('a', { href: engine.screenshot(), download: 'helix.png' }).click());

  const loadFile = async (f) => {
    if (!f) return;
    try {
      const root = await engine.load(f);
      show('Your model', { object: root, tick: (t) => { root.rotation.y = t * 0.3 * speed; } });
      toast(`Loaded ${f.name}`);
    } catch (err) {
      toast(`Could not load ${f.name}: ${err.message}`, 'err');
    }
  };
  $('#glb').addEventListener('click', () => {
    const input = h('input', { type: 'file', accept: '.glb,.gltf' });
    input.addEventListener('change', () => loadFile(input.files[0]));
    input.click();
  });
  const box = $('#studio');
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('dropzone-active'); });
  box.addEventListener('dragleave', () => box.classList.remove('dropzone-active'));
  box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('dropzone-active'); loadFile(e.dataTransfer.files[0]); });

  let frames = 0;
  let last = performance.now();
  engine.onFrame(() => {
    frames++;
    const now = performance.now();
    if (now - last > 1000) {
      const info = engine.renderer.info.render;
      $('#studio-stats').textContent = `Helix · ${frames} fps · ${info.triangles.toLocaleString()} triangles`;
      frames = 0;
      last = now;
    }
  });
  show('Showcase');
  engine.start();
}

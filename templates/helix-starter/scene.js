import { Helix, Models, createStarfield } from 'helix';

const engine = new Helix(document.getElementById('scene'), { bloom: true, autoRotate: true, zoom: false, camera: [1.2, 0.3, 5] });

// The planet's material is a Pyre program, compiled to GLSL in the browser.
const lava = engine.material(await fetch('./shaders/lava.pyre').then((r) => r.text()));
const planet = engine.add(engine.mesh(Models.sphere(), lava));
planet.position.x = window.innerWidth > 800 ? 1.6 : 0;
engine.add(createStarfield({ count: 1500 }));
engine.onFrame((t) => { planet.rotation.y = t * 0.15; });
engine.start();

// api/saxpy.pyre is deployed as an HTTP function: POST /api/fn/<project>/saxpy
const project = location.pathname.split('/')[2] || 'dev';
document.getElementById('run').addEventListener('click', async () => {
  const out = document.getElementById('out');
  const res = await fetch(`/api/fn/${project}/saxpy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uniforms: { a: 2 }, buffers: { x: [1, 2, 3, 4], y: [10, 10, 10, 10] } }),
  });
  const data = await res.json();
  out.textContent = res.ok ? `y = 2·x + y → [${data.buffers.y.join(', ')}]  (${data.ms} ms)` : `error: ${data.error}`;
});

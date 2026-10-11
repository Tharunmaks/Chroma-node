import { Helix, createStarfield } from 'helix';
import { build } from 'helix/catalog.js';
import { chroma } from '/assets/js/chroma-sdk.js';

// --- 3D: a 4D polytope from the Helix library (polytope/3 is the 24-cell) ---
const engine = new Helix(document.getElementById('scene'), { autoRotate: true, zoom: false, camera: [0, 0, 5] });
const shape = engine.add(build('polytope', { kind: 3 }));
shape.position.x = window.innerWidth > 900 ? 1.8 : 0;
engine.add(createStarfield({ count: 1200 }));
engine.onFrame((t, dt) => shape.update(dt));
engine.start();

// --- realtime database + server function + analytics events ---
const app = chroma();
const book = app.db('guestbook');
const list = document.getElementById('list');
const render = (doc, top = true) => {
  const li = document.createElement('li');
  const b = document.createElement('b');
  b.textContent = doc.name;
  li.append(b, document.createTextNode(` — ${doc.message}`));
  top ? list.prepend(li) : list.append(li);
};

async function load() {
  try {
    const { docs } = await book.list({ order: '-_created', limit: 30 });
    list.replaceChildren();
    docs.forEach((d) => render(d, false));
    book.subscribe((change) => { if (change.type === 'add') { render(change.doc); refreshStats(); } });
    refreshStats();
  } catch (err) {
    document.getElementById('stats').textContent = `Set up the "guestbook" collection in the dashboard (read: public, write: anyone can add). ${err.message}`;
  }
}

async function refreshStats() {
  const el = document.getElementById('stats');
  try {
    const stats = await app.fn('stats', { method: 'GET' });
    el.textContent = `${stats.total} signatures so far · counted by api/stats.js`;
  } catch (err) {
    el.textContent = `Server function unavailable: ${err.message}`;
  }
}

document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  try {
    await book.add({ name: f.name.value.slice(0, 40), message: f.message.value.slice(0, 280) });
    app.track('guestbook.signed');
    f.message.value = '';
  } catch (err) {
    alert(err.message);
  }
});
load();

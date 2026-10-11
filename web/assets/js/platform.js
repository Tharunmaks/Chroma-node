// Platform page: highlighted code samples and a simulated live-analytics demo.
import { $, highlightJS } from './common.js';
import { lineChart } from './charts.js';

$('#code-db').innerHTML = highlightJS(`import { chroma } from '/assets/js/chroma-sdk.js';
const app = chroma();             // project detected from the URL
const book = app.db('guestbook');

form.onsubmit = async (e) => {
  e.preventDefault();
  await book.add({ name: form.name.value, message: form.msg.value });
};

const { docs } = await book.list({ order: '-_created', limit: 20 });
docs.forEach(render);
book.subscribe(({ type, doc }) => type === 'add' && render(doc));`);

$('#code-fn').innerHTML = highlightJS(`// GET or POST /api/fn/<project>/guestbook
export default async function (req, { db }) {
  const book = db.collection('guestbook');
  if (req.method === 'POST') {
    if (!req.body?.message) return { status: 400, json: { error: 'message required' } };
    const doc = await book.add({ name: req.body.name || 'anon', message: req.body.message.slice(0, 280) });
    return { status: 201, json: doc };
  }
  const { docs, total } = await book.list({ order: '-_created', limit: 10 });
  return { json: { total, latest: docs } };
}`);

$('#code-track').innerHTML = highlightJS(`chroma().track('signup');        // shows up live under "Custom events"`);

// simulated traffic: a smooth daily-ish wave with noise, advancing every 2 s
const now = Date.now();
const pts = Array.from({ length: 60 }, (_, i) => {
  const t = now - (59 - i) * 60e3;
  const base = 22 + 10 * Math.sin(i / 9);
  return { t, views: Math.round(base + Math.random() * 8), visitors: Math.round(base * 0.55 + Math.random() * 4) };
});
const fmt = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const toSeries = () => [
  { name: 'Page views', values: pts.map((p) => ({ x: p.t, y: p.views })) },
  { name: 'Visitors', values: pts.map((p) => ({ x: p.t, y: p.visitors })) },
];
const chart = lineChart($('#demo-chart'), { series: toSeries(), xFormat: fmt, label: 'Simulated traffic' });
let views = 1284;
let fn = 316;
setInterval(() => {
  if (document.hidden) return;
  const last = pts.at(-1);
  const i = pts.length;
  const base = 22 + 10 * Math.sin((i + (Date.now() - now) / 2000) / 9);
  pts.shift();
  pts.push({ t: last.t + 60e3, views: Math.round(base + Math.random() * 8), visitors: Math.round(base * 0.55 + Math.random() * 4) });
  chart.update({ series: toSeries() });
  views += Math.round(Math.random() * 6);
  fn += Math.round(Math.random() * 2);
  $('#demo-views').textContent = views.toLocaleString();
  $('#demo-fn').textContent = fn.toLocaleString();
  $('#demo-live').textContent = String(9 + Math.round(Math.random() * 7));
  const dot = $('#demo-dot');
  dot.classList.remove('pulse');
  void dot.offsetWidth;
  dot.classList.add('pulse');
}, 2000);

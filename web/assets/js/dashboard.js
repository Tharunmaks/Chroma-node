// Dashboard: sign in / sign up, projects, deployments (drag-and-drop folder
// upload, promote, rollback, logs), API tokens and security settings.
// All user-controlled text is inserted with textContent (via h()), never HTML.
import { $, h, api, me, setCsrf, toast, copyText, DEMO } from './common.js';
import { lineChart, barList } from './charts.js';

const app = $('#app');
let user = null;
let view = { name: 'projects' };

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const ago = (iso) => {
  if (!iso) return 'never';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};
const icon = (d) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  svg.append(p);
  return svg;
};
const ICONS = {
  projects: 'M3 7l9-4 9 4-9 4-9-4zM3 12l9 4 9-4M3 17l9 4 9-4',
  tokens: 'M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7z',
  security: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z',
  out: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
};

// ---------------- auth ----------------
function renderAuth(signup) {
  const allowSignup = signup !== false;
  let mode = location.hash === '#signup' || location.hash === '#new' ? 'signup' : 'login';
  const err = h('div');
  const username = h('input', { name: 'username', autocomplete: 'username', required: true, minlength: 3, maxlength: 32, pattern: '[A-Za-z0-9][A-Za-z0-9_\\-]{1,30}[A-Za-z0-9]' });
  const password = h('input', { name: 'password', type: 'password', required: true, minlength: 10, maxlength: 256 });
  const submit = h('button', { class: 'btn primary', type: 'submit' });
  const hint = h('p', { class: 'small dim' });
  const tabs = h('div', { class: 'seg', role: 'tablist' });
  const setMode = (m) => {
    mode = m;
    submit.textContent = m === 'login' ? 'Sign in' : 'Create account';
    password.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    hint.textContent = m === 'login' ? '' : 'At least 10 characters. Passwords are hashed with scrypt; we never store them.';
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.m === m));
    err.replaceChildren();
  };
  tabs.append(
    h('button', { type: 'button', role: 'tab', 'data-m': 'login', onclick: () => setMode('login') }, 'Sign in'),
    allowSignup ? h('button', { type: 'button', role: 'tab', 'data-m': 'signup', onclick: () => setMode('signup') }, 'Create account') : null,
  );
  const form = h('form', { class: 'form' },
    tabs,
    h('label', {}, 'Username', username),
    h('label', {}, 'Password', password),
    hint, err, submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      const d = await api('POST', mode === 'login' ? '/api/auth/login' : '/api/auth/signup', { username: username.value.trim(), password: password.value });
      setCsrf(d.csrf);
      user = d.user;
      if (location.hash === '#signup') history.replaceState(null, '', '#new');
      await me(true);
      start();
    } catch (ex) {
      err.replaceChildren(h('div', { class: 'alert err' }, ex.message));
    } finally {
      submit.disabled = false;
    }
  });
  setMode(allowSignup ? mode : 'login');
  app.replaceChildren(h('div', { class: 'panel auth-box' },
    h('div', { class: 'panel-body' },
      h('h1', { class: 'title' }, mode === 'signup' ? 'Start deploying' : 'Welcome back'),
      h('p', { class: 'muted' }, 'Sign in to manage projects, deployments and API tokens.'),
      form)));
  username.focus();
}

// ---------------- shell ----------------
function shell(content) {
  const nav = (name, label) => h('button', { 'aria-current': String(view.name === name || (name === 'projects' && view.name === 'project')), onclick: () => go({ name }) }, icon(ICONS[name]), label);
  app.replaceChildren(h('div', { class: 'dash' },
    h('aside', {},
      h('div', { class: 'who' }, h('div', { class: 'dim small' }, 'Signed in as'), h('b', {}, user.username)),
      nav('projects', 'Projects'),
      nav('tokens', 'API tokens'),
      nav('security', 'Security'),
      h('button', { onclick: logout }, icon(ICONS.out), 'Sign out')),
    h('main', {}, content)));
}

function go(v) {
  view = v;
  render();
}

async function logout() {
  try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ }
  user = null;
  location.href = '/';
}

let cleanup = null;
async function render() {
  if (cleanup) { cleanup(); cleanup = null; }
  try {
    if (view.name === 'projects') return shell(await projectsView());
    if (view.name === 'project') return shell(await projectView(view.project, view.tab || 'deployments'));
    if (view.name === 'tokens') return shell(await tokensView());
    if (view.name === 'security') return shell(await securityView());
  } catch (err) {
    if (err.status === 401) return renderAuth();
    shell(h('div', { class: 'alert err' }, err.message));
  }
}

// ---------------- projects ----------------
async function projectsView() {
  const { projects } = await api('GET', '/api/projects');
  const grid = h('div', { class: 'grid cols-2' });
  for (const p of projects) {
    const status = p.latest ? h('span', { class: `status ${p.latest.status}` }, p.latest.status) : h('span', { class: 'dim small' }, 'no deployments');
    grid.append(h('div', { class: 'panel project-card' },
      h('div', { class: 'preview' }, p.production
        ? h('iframe', { src: p.url, title: `${p.name} preview`, loading: 'lazy', sandbox: 'allow-scripts', tabindex: '-1' })
        : h('div', { class: 'empty small' }, 'Deploy to see a preview')),
      h('div', { class: 'row' }, h('h3', {}, p.name), h('span', { class: 'spacer' }), status),
      h('div', { class: 'row small muted' },
        p.production ? h('a', { href: p.url, target: '_blank', rel: 'noopener' }, location.host + p.url) : h('span', {}, 'not live yet'),
        h('span', { class: 'spacer' }),
        h('span', {}, `${p.deployments} deployment${p.deployments === 1 ? '' : 's'}`)),
      h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => go({ name: 'project', project: p.name }) }, 'Open project →'))));
  }
  const head = h('div', { class: 'row' },
    h('div', {}, h('h1', { class: 'title' }, 'Projects'), h('p', { class: 'muted' }, 'Each project has a production URL and an immutable history of deployments.')),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn primary', onclick: newProjectDialog }, '+ New project'));
  if (location.hash === '#new') {
    history.replaceState(null, '', location.pathname);
    setTimeout(newProjectDialog, 0);
  }
  return [head, projects.length ? grid : h('div', { class: 'panel empty' },
    h('h3', {}, 'No projects yet'),
    h('p', {}, 'Create one from a template — the Helix starter deploys a live 3D page in a second.'),
    h('button', { class: 'btn primary', onclick: newProjectDialog }, 'Create your first project'))];
}

async function newProjectDialog() {
  const { templates } = await api('GET', '/api/templates');
  const name = h('input', { required: true, maxlength: 40, pattern: '[a-z0-9]([a-z0-9\\-]{0,38}[a-z0-9])?', placeholder: 'my-3d-site', autocomplete: 'off' });
  const tpl = h('select', {},
    ...templates.map((t) => h('option', { value: t.id }, `${t.name} — ${t.description}`)),
    h('option', { value: '' }, 'Empty — I will upload files'));
  const msg = h('div');
  const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Create');
  const dlg = h('dialog', {}, h('form', { class: 'panel-body form' },
    h('h3', {}, 'New project'),
    h('label', {}, 'Name (becomes the URL)', name),
    h('label', {}, 'Start from', tpl),
    msg,
    h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'), ok)));
  dlg.addEventListener('close', () => dlg.remove());
  dlg.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    ok.disabled = true;
    msg.replaceChildren(h('div', { class: 'alert info' }, 'Creating…'));
    try {
      const n = name.value.trim().toLowerCase();
      await api('POST', '/api/projects', { name: n });
      if (tpl.value) await api('POST', `/api/projects/${encodeURIComponent(n)}/templates/${encodeURIComponent(tpl.value)}`);
      dlg.close();
      toast(tpl.value ? `${n} is live` : `Created ${n}`);
      go({ name: 'project', project: n });
    } catch (err) {
      msg.replaceChildren(h('div', { class: 'alert err' }, err.message));
      ok.disabled = false;
    }
  });
  document.body.append(dlg);
  dlg.showModal();
  name.focus();
}

// ---------------- one project ----------------
async function projectView(name, tab) {
  const { project, deployments } = await api('GET', `/api/projects/${encodeURIComponent(name)}`);
  const prodUrl = location.origin + project.url;
  const head = h('div', { class: 'row' },
    h('div', {},
      h('p', { class: 'small' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); go({ name: 'projects' }); } }, '← Projects')),
      h('h1', { class: 'title' }, project.name),
      project.production
        ? h('p', { class: 'row small' }, h('span', { class: 'tag prod' }, 'PRODUCTION'), h('a', { href: project.url, target: '_blank', rel: 'noopener' }, prodUrl), h('button', { class: 'copy', onclick: (e) => copyText(prodUrl, e.currentTarget) }, 'Copy'))
        : h('p', { class: 'muted small' }, 'No production deployment yet.')),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn danger small', onclick: () => deleteProject(project.name) }, 'Delete project'));

  const rows = deployments.map((d) => h('tr', {},
    h('td', {}, h('span', { class: `status ${d.status}` }, d.status)),
    h('td', {}, h('a', { href: d.url, target: '_blank', rel: 'noopener' }, h('code', {}, d.id)), d.production ? [' ', h('span', { class: 'tag prod' }, 'PROD')] : null),
    h('td', { class: 'muted' }, ago(d.createdAt)),
    h('td', { class: 'muted' }, d.source),
    h('td', { class: 'muted' }, `${d.fileCount} files · ${fmtSize(d.size)}`),
    h('td', { class: 'muted' }, d.functions.length ? d.functions.map((f) => `fn ${f}`).join(', ') : '—'),
    h('td', {}, h('div', { class: 'row' },
      h('button', { class: 'btn small', onclick: () => showLog(d.id) }, 'Log'),
      !d.production && d.status === 'READY' ? h('button', { class: 'btn small', onclick: () => promote(project.name, d.id) }, 'Promote') : null,
      !d.production ? h('button', { class: 'btn small danger', 'aria-label': `Delete deployment ${d.id}`, onclick: () => deleteDeployment(project.name, d.id) }, 'Delete') : null))));

  const tabs = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Project sections' },
    ...[['deployments', 'Deployments'], ['analytics', 'Analytics'], ['database', 'Database']].map(([k, label]) => h('button', {
      role: 'tab', 'aria-selected': String(tab === k), onclick: () => go({ name: 'project', project: project.name, tab: k }),
    }, label)));
  if (tab === 'analytics') return [head, tabs, ...(await analyticsView(project))];
  if (tab === 'database') return [head, tabs, ...(await databaseView(project))];
  return [
    head,
    tabs,
    uploader(project.name),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Deployments'), h('span', { class: 'spacer' }), h('span', { class: 'small dim' }, 'Promote any READY deployment to roll back instantly')),
      deployments.length
        ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
          h('thead', {}, h('tr', {}, ...['Status', 'Deployment', 'Created', 'Source', 'Size', 'Functions', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, rows)))
        : h('div', { class: 'empty' }, 'No deployments yet — drop a folder above.')),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Deploy from your terminal')),
      h('div', { class: 'panel-body' },
        h('pre', { class: 'log' }, `npm i -g github:Tharunmaks/Chroma-node\nchroma login --server ${location.origin}\nchroma deploy ./my-site --project ${project.name}`))),
  ];
}

// ---------------- analytics ----------------
const nf = new Intl.NumberFormat('en');
async function analyticsView(project) {
  let range = view.range || '1h';
  const kpis = h('div', { class: 'kpi-row' });
  const chartBox = h('div');
  const feed = h('div', { class: 'feed', 'aria-live': 'off' });
  const lists = { pages: h('div'), referrers: h('div'), devices: h('div'), functions: h('div'), events: h('div'), statuses: h('div') };
  const liveDot = h('span', { class: 'live-dot', 'aria-hidden': 'true' });
  const liveNum = h('b', {}, '0');
  let chart = null;
  let refreshTimer = null;

  const fmtTime = (t) => {
    const d = new Date(t);
    return range === '1h' || range === '24h' ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: range === '7d' ? '2-digit' : undefined });
  };
  async function load() {
    const a = await api('GET', `/api/projects/${encodeURIComponent(project.name)}/analytics?range=${range}`);
    liveNum.textContent = nf.format(a.live);
    const t = a.totals;
    kpis.replaceChildren(
      h('div', { class: 'kpi-card live' }, h('span', {}, liveDot, 'Visitors now'), liveNum),
      ...[['Page views', t.views], ['Unique visitors', t.visitors], ['Function calls', t.fnCalls], ['Database calls', t.dbCalls], ['Custom events', t.events], ['Errors', t.errors], ['Avg response', `${t.avgMs} ms`]]
        .map(([k, v]) => h('div', { class: 'kpi-card' }, h('span', {}, k), h('b', {}, typeof v === 'number' ? nf.format(v) : v))),
    );
    const series = [
      { name: 'Page views', values: a.series.map((p) => ({ x: p.t, y: p.views })) },
      { name: 'Visitors', values: a.series.map((p) => ({ x: p.t, y: p.visitors })) },
    ];
    if (!chart) chart = lineChart(chartBox, { series, xFormat: fmtTime, label: 'Traffic over time' });
    else chart.update({ series, xFormat: fmtTime });
    barList(lists.pages, a.pages, { empty: 'No page views yet' });
    barList(lists.referrers, a.referrers, { empty: 'No referrers yet' });
    barList(lists.devices, a.devices, { empty: '—' });
    barList(lists.functions, a.functions, { empty: 'No function calls yet' });
    barList(lists.events, a.events, { empty: 'Send events with chroma().track(name)' });
    barList(lists.statuses, a.statuses.map((r) => ({ key: `HTTP ${r.key}`, n: r.n })), { empty: '—' });
  }
  await load();

  const es = new EventSource(`/api/projects/${encodeURIComponent(project.name)}/analytics/stream`);
  es.addEventListener('live', (e) => { liveNum.textContent = nf.format(JSON.parse(e.data).visitors); });
  es.addEventListener('hit', (e) => {
    const hit = JSON.parse(e.data);
    const what = hit.kind === 'page' ? hit.path : hit.kind === 'fn' ? `fn ${hit.name}` : hit.kind === 'event' ? `event ${hit.name}` : `db ${hit.name}`;
    feed.prepend(h('div', { class: `feed-row ${hit.status >= 400 ? 'bad' : ''}` },
      h('span', { class: 'tag' }, hit.kind), h('span', { class: 'k' }, what || '/'),
      h('span', { class: 'dim' }, [hit.status, hit.ms !== null ? `${hit.ms} ms` : null, hit.device, hit.ref].filter(Boolean).join(' · ')),
      h('span', { class: 'dim' }, new Date(hit.ts).toLocaleTimeString())));
    while (feed.children.length > 40) feed.lastChild.remove();
    liveDot.classList.remove('pulse');
    void liveDot.offsetWidth;
    liveDot.classList.add('pulse');
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(load, 1500);
  });
  const poll = setInterval(load, 30000);
  cleanup = () => { es.close(); clearInterval(poll); clearTimeout(refreshTimer); };

  const rangeSel = h('div', { class: 'seg', role: 'group', 'aria-label': 'Time range' }, ...['1h', '24h', '7d', '30d'].map((r) => h('button', {
    'aria-selected': String(r === range), onclick: (e) => { range = r; view.range = r; for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-selected', String(b === e.currentTarget)); load(); },
  }, r)));
  const card = (title, el) => h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, title)), h('div', { class: 'panel-body' }, el));
  return [
    h('div', { class: 'row' }, h('p', { class: 'small muted' }, 'Privacy-friendly: no cookies, no stored IPs. Visitors are counted with a hash that rotates daily. Updates live.'), h('span', { class: 'spacer' }), rangeSel),
    kpis,
    card('Traffic', chartBox),
    h('div', { class: 'grid cols-2' }, card('Live requests', feed), card('Top pages', lists.pages)),
    h('div', { class: 'grid cols-3' }, card('Referrers', lists.referrers), card('Devices', lists.devices), card('Status codes', lists.statuses)),
    h('div', { class: 'grid cols-2' }, card('Functions', lists.functions), card('Custom events', lists.events)),
  ];
}

// ---------------- database ----------------
async function databaseView(project) {
  const base = `/api/projects/${encodeURIComponent(project.name)}/db`;
  const { collections, limits } = await api('GET', base);
  const selected = view.collection && collections.some((c) => c.name === view.collection) ? view.collection : collections[0]?.name;
  const RULES = { read: [['private', 'Owner only'], ['public', 'Anyone (public read)']], write: [['private', 'Owner only'], ['create', 'Anyone can add'], ['public', 'Anyone can add, edit, delete']] };
  const ruleSel = (c, kind) => {
    const sel = h('select', { 'aria-label': `${kind} rule for ${c.name}` }, ...RULES[kind].map(([v, l]) => h('option', { value: v }, l)));
    sel.value = c[kind];
    sel.addEventListener('change', async () => {
      try { await api('PUT', `${base}/${c.name}/rules`, { [kind]: sel.value }); toast(`${c.name}: ${kind} → ${sel.value}`); } catch (err) { toast(err.message, 'err'); }
    });
    return sel;
  };
  const list = h('div', { class: 'table-scroll' }, collections.length ? h('table', { class: 'list' },
    h('thead', {}, h('tr', {}, ...['Collection', 'Documents', 'Read', 'Write', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, collections.map((c) => h('tr', { class: c.name === selected ? 'sel' : '' },
      h('td', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); view.collection = c.name; render(); } }, h('code', {}, c.name))),
      h('td', { class: 'muted' }, nf.format(c.count)),
      h('td', {}, ruleSel(c, 'read')), h('td', {}, ruleSel(c, 'write')),
      h('td', {}, h('button', { class: 'btn small danger', onclick: async () => {
        if (!confirm(`Delete collection ${c.name} and its ${c.count} documents?`)) return;
        await api('DELETE', `${base}/${c.name}`);
        render();
      } }, 'Delete')))))) : h('div', { class: 'empty' }, 'No collections yet.'));

  const name = h('input', { placeholder: 'e.g. guestbook', maxlength: 40, required: true, pattern: '[a-z0-9][a-z0-9_\\-]{0,39}' });
  const read = h('select', {}, ...RULES.read.map(([v, l]) => h('option', { value: v }, l)));
  const write = h('select', {}, ...RULES.write.map(([v, l]) => h('option', { value: v }, l)));
  const form = h('form', { class: 'row' }, h('label', { class: 'spacer' }, 'New collection', name), h('label', {}, 'Read', read), h('label', {}, 'Write', write), h('button', { class: 'btn primary', type: 'submit' }, 'Create'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', base, { name: name.value.trim(), read: read.value, write: write.value }); view.collection = name.value.trim(); render(); } catch (err) { toast(err.message, 'err'); }
  });

  let docsPanel = h('div');
  if (selected) {
    const { docs, total } = await api('GET', `${base}/${selected}?limit=50`);
    const json = h('textarea', { rows: 3, placeholder: '{ "name": "Ada", "score": 42 }', 'aria-label': 'New document JSON' });
    const add = h('button', { class: 'btn small', onclick: async () => {
      try { await api('POST', `${base}/${selected}/docs`, JSON.parse(json.value || '{}')); render(); } catch (err) { toast(err.message, 'err'); }
    } }, 'Add document');
    docsPanel = h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', {}, `${selected} · ${nf.format(total)} documents`), h('span', { class: 'spacer' }), h('button', { class: 'btn small', onclick: () => render() }, 'Refresh')),
      h('div', { class: 'panel-body form' },
        docs.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
          h('thead', {}, h('tr', {}, ...['_id', 'Created', 'Data', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, docs.map((d) => {
            const { _id, _created, _updated, ...rest } = d;
            return h('tr', {}, h('td', {}, h('code', {}, _id)), h('td', { class: 'muted' }, new Date(_created).toLocaleString()),
              h('td', {}, h('code', { class: 'doc' }, JSON.stringify(rest).slice(0, 160))),
              h('td', {}, h('button', { class: 'btn small danger', onclick: async () => { await api('DELETE', `${base}/${selected}/docs/${_id}`); render(); } }, 'Delete')));
          })))) : h('p', { class: 'small muted' }, 'Empty collection.'),
        h('div', { class: 'row' }, h('div', { class: 'spacer' }, json), add)));
  }
  const sdk = `import { chroma } from '/assets/js/chroma-sdk.js';
const app = chroma();                       // "${project.name}", detected from the URL

await app.db('${selected || 'guestbook'}').add({ name: 'Ada', message: 'Hello!' });
const { docs } = await app.db('${selected || 'guestbook'}').list({ order: '-_created', limit: 20 });
app.db('${selected || 'guestbook'}').subscribe((change) => console.log(change.type, change.doc));`;
  return [
    h('p', { class: 'small muted' }, `A JSON document database for your deployed site. Limits: ${limits.collections} collections, ${nf.format(limits.docsPerCollection)} documents each, ${limits.docBytes / 1024} KB per document. Your API token bypasses the rules from servers and CI.`),
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, 'Collections')), list, h('div', { class: 'panel-body' }, form)),
    docsPanel,
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, 'Use it from your site'), h('span', { class: 'spacer' }), h('button', { class: 'copy', onclick: (e) => copyText(sdk, e.currentTarget) }, 'Copy')), h('div', { class: 'panel-body' }, h('pre', { class: 'log' }, sdk))),
  ];
}

async function deleteProject(name) {
  if (!confirm(`Delete ${name} and all of its deployments? This cannot be undone.`)) return;
  try {
    await api('DELETE', `/api/projects/${encodeURIComponent(name)}`);
    toast(`Deleted ${name}`);
    go({ name: 'projects' });
  } catch (err) { toast(err.message, 'err'); }
}

async function promote(project, id) {
  try {
    await api('POST', `/api/projects/${encodeURIComponent(project)}/promote`, { deploymentId: id });
    toast('Production updated');
    go({ name: 'project', project });
  } catch (err) { toast(err.message, 'err'); }
}

async function deleteDeployment(project, id) {
  if (!confirm('Delete this deployment?')) return;
  try {
    await api('DELETE', `/api/deployments/${encodeURIComponent(id)}`);
    go({ name: 'project', project });
  } catch (err) { toast(err.message, 'err'); }
}

async function showLog(id) {
  const { deployment } = await api('GET', `/api/deployments/${encodeURIComponent(id)}`);
  const log = h('pre', { class: 'log' }, ...deployment.log.map((l) => h('div', { class: l.level }, `${l.level.toUpperCase().padEnd(5)} ${l.file ? l.file + ': ' : ''}${l.message}`)));
  const files = h('details', {}, h('summary', { class: 'small muted' }, `${deployment.files.length} files`),
    h('pre', { class: 'log' }, deployment.files.map((f) => `${f.path}  ${fmtSize(f.size)}`).join('\n')));
  const dlg = h('dialog', {}, h('div', { class: 'panel-body form' },
    h('h3', {}, `Build log · ${deployment.id}`), log, files,
    h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { class: 'btn', onclick: () => dlg.close() }, 'Close'))));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

// ---------------- uploads ----------------
const IGNORED = /(^|\/)(\.[^/]*|node_modules)(\/|$)/;

async function walkEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ path: prefix + entry.name, file });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const e of batch) await walkEntry(e, `${prefix}${entry.name}/`, out);
    } while (batch.length);
  }
}

function stripCommonRoot(list) {
  const first = list[0]?.path.split('/')[0];
  if (list.length && list.every((f) => f.path.includes('/') && f.path.split('/')[0] === first)) {
    for (const f of list) f.path = f.path.slice(first.length + 1);
  }
  return list;
}

function uploader(project) {
  const bar = h('i');
  const status = h('p', { class: 'small muted' }, 'Drop a site folder here, or click to choose one. index.html is served at the root; .pyre files are compiled.');
  const input = h('input', { type: 'file', multiple: true, webkitdirectory: true, class: 'sr-only', 'aria-label': 'Choose a folder to deploy' });
  const zone = h('div', { class: 'drop', role: 'button', tabindex: '0' },
    h('h3', {}, 'Deploy files'), status, h('div', { class: 'progress', 'aria-hidden': 'true' }, bar), input);
  zone.addEventListener('click', (e) => { if (e.target !== input) input.click(); });
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const list = [];
    const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if (entries.length) for (const en of entries) await walkEntry(en, '', list);
    else for (const f of e.dataTransfer.files) list.push({ path: f.name, file: f });
    upload(stripCommonRoot(list));
  });
  input.addEventListener('change', () => upload(stripCommonRoot([...input.files].map((f) => ({ path: f.webkitRelativePath || f.name, file: f })))));

  async function upload(list) {
    list = list.filter((f) => !IGNORED.test(f.path));
    if (!list.length) { status.textContent = 'No files to deploy (hidden files and node_modules are skipped).'; return; }
    const total = list.reduce((s, f) => s + f.file.size, 0);
    if (total > 50 * 1024 * 1024) { status.textContent = `That's ${fmtSize(total)}; the limit is 50 MB per deployment.`; return; }
    if (!list.some((f) => f.path === 'index.html')) status.textContent = 'Note: no index.html at the root, so / will 404.';
    try {
      const files = [];
      let done = 0;
      for (const f of list) {
        const buf = new Uint8Array(await f.file.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        files.push({ path: f.path, data: btoa(bin) });
        done += f.file.size;
        bar.style.width = `${Math.round((done / Math.max(1, total)) * 70)}%`;
        status.textContent = `Reading ${files.length}/${list.length} files…`;
      }
      status.textContent = `Uploading ${list.length} files (${fmtSize(total)}) and building…`;
      bar.style.width = '85%';
      const res = await api('POST', `/api/projects/${encodeURIComponent(project)}/deployments`, { files, target: 'production' });
      bar.style.width = '100%';
      if (res.deployment.status === 'READY') toast(`Deployed ${res.deployment.id} to production`);
      else toast('Build failed — see the log', 'err');
      go({ name: 'project', project });
      if (res.deployment.status !== 'READY') setTimeout(() => showLog(res.deployment.id), 50);
    } catch (err) {
      status.textContent = err.message;
      bar.style.width = '0';
      toast(err.message, 'err');
    }
  }
  return zone;
}

// ---------------- tokens ----------------
async function tokensView() {
  const { tokens } = await api('GET', '/api/tokens');
  const name = h('input', { placeholder: 'e.g. laptop, CI', maxlength: 60, required: true });
  const out = h('div');
  const form = h('form', { class: 'row' }, h('div', { class: 'spacer' }, name), h('button', { class: 'btn primary', type: 'submit' }, 'Create token'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { token } = await api('POST', '/api/tokens', { name: name.value.trim() });
      out.replaceChildren(h('div', { class: 'alert ok' },
        h('p', {}, 'Copy this token now — it will not be shown again.'),
        h('div', { class: 'install' }, h('code', {}, token), h('button', { class: 'copy', type: 'button', onclick: (ev) => copyText(token, ev.currentTarget) }, 'Copy')),
        h('p', { class: 'small' }, `CLI: chroma login --server ${location.origin} --token <token>`)));
      name.value = '';
      const list = await tokensTable();
      $('#token-table').replaceWith(list);
    } catch (err) { out.replaceChildren(h('div', { class: 'alert err' }, err.message)); }
  });
  async function tokensTable(list) {
    const data = list || (await api('GET', '/api/tokens')).tokens;
    return h('div', { id: 'token-table', class: 'table-scroll' }, data.length
      ? h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, ...['Name', 'Token', 'Created', 'Last used', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, data.map((t) => h('tr', {},
          h('td', {}, t.name), h('td', {}, h('code', {}, `${t.prefix}…`)), h('td', { class: 'muted' }, ago(t.createdAt)), h('td', { class: 'muted' }, ago(t.lastUsedAt)),
          h('td', {}, h('button', { class: 'btn small danger', onclick: async () => {
            if (!confirm(`Revoke "${t.name}"? Anything using it will stop working.`)) return;
            await api('DELETE', `/api/tokens/${encodeURIComponent(t.id)}`);
            go({ name: 'tokens' });
          } }, 'Revoke'))))))
      : h('div', { class: 'empty' }, 'No tokens yet.'));
  }
  return [
    h('div', {}, h('h1', { class: 'title' }, 'API tokens'), h('p', { class: 'muted' }, 'Tokens let the CLI and CI deploy on your behalf. Only a hash is stored; revoke any time.')),
    h('section', { class: 'panel' }, h('div', { class: 'panel-body form' }, form, out)),
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Active tokens')), await tokensTable(tokens)),
  ];
}

// ---------------- security ----------------
async function securityView() {
  const { events } = await api('GET', '/api/audit');
  const current = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10 });
  const msg = h('div');
  const form = h('form', { class: 'form' }, h('label', {}, 'Current password', current), h('label', {}, 'New password (10+ characters)', next), msg,
    h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, 'Change password')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const d = await api('POST', '/api/auth/password', { current: current.value, next: next.value });
      setCsrf(d.csrf);
      form.reset();
      msg.replaceChildren(h('div', { class: 'alert ok' }, 'Password changed. Other sessions were signed out.'));
    } catch (err) { msg.replaceChildren(h('div', { class: 'alert err' }, err.message)); }
  });
  const LABELS = {
    'user.signup': 'Account created', login: 'Signed in', 'login.failed': 'Failed sign-in attempt', 'account.locked': 'Account locked after failed sign-ins',
    'password.changed': 'Password changed', 'token.created': 'API token created', 'token.revoked': 'API token revoked', 'project.created': 'Project created',
    'project.deleted': 'Project deleted', 'deployment.created': 'Deployment created', 'deployment.promoted': 'Deployment promoted', 'deployment.deleted': 'Deployment deleted',
  };
  return [
    h('div', {}, h('h1', { class: 'title' }, 'Security'), h('p', { class: 'muted' }, 'Your password, and a log of every sensitive action on your account.')),
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Change password')), h('div', { class: 'panel-body' }, form)),
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Audit log'), h('span', { class: 'spacer' }), h('span', { class: 'small dim' }, 'last 100 events')),
      events.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, ...['Event', 'Details', 'IP', 'When'].map((t) => h('th', {}, t)))),
        h('tbody', {}, events.map((ev) => h('tr', {},
          h('td', {}, ev.event.includes('failed') || ev.event.includes('locked') ? h('span', { class: 'status ERROR' }, LABELS[ev.event] || ev.event) : (LABELS[ev.event] || ev.event)),
          h('td', { class: 'muted small' }, ev.detail ? Object.entries(ev.detail).map(([k, v]) => `${k}: ${v}`).join(' · ') : ''),
          h('td', { class: 'muted' }, ev.ip || ''),
          h('td', { class: 'muted' }, ago(ev.at)))))))
        : h('div', { class: 'empty' }, 'Nothing yet.')),
  ];
}

// ---------------- boot ----------------
function renderDemo() {
  app.replaceChildren(h('div', { class: 'panel auth-box' }, h('div', { class: 'panel-body form' },
    h('h1', { class: 'title' }, 'Run your own Chroma'),
    h('p', { class: 'muted' }, 'You are on the static live demo. The models, studio, playground, Torch notebook and engine all work here. Accounts, deploys, the realtime database, server functions and live analytics need a Chroma server — it takes a minute:'),
    h('pre', { class: 'log' }, `git clone https://github.com/Tharunmaks/Chroma-node
cd Chroma-node && npm install && npm start
# open http://127.0.0.1:3000/dashboard`),
    h('div', { class: 'row' }, h('a', { class: 'btn primary', href: 'https://github.com/Tharunmaks/Chroma-node' }, 'Get it on GitHub'), h('a', { class: 'btn', href: '../docs/#selfhost' }, 'Self-hosting guide')))));
}

async function start() {
  if (DEMO) return renderDemo();
  const d = await me(true);
  if (!d.user) return renderAuth(d.signup);
  user = d.user;
  const account = $('[data-account]');
  if (account) { account.textContent = 'Dashboard'; account.setAttribute('href', '/dashboard'); }
  render();
}
start();

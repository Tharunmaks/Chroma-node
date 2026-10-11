// Chroma browser SDK for deployed sites: database, realtime, functions, events.
//
//   import { chroma } from '/assets/js/chroma-sdk.js';
//   const app = chroma();                         // project detected from the URL
//   await app.db('guestbook').add({ name: 'Ada', message: 'hi' });
//   const { docs } = await app.db('guestbook').list({ order: '-_created', limit: 20 });
//   app.db('guestbook').subscribe((change) => console.log(change.type, change.doc));
//   const out = await app.fn('hello', { method: 'POST', body: { name: 'Ada' } });
//   app.track('signup');                          // custom analytics event
//
// Page views are counted by the server automatically; no script needed.

function detectProject() {
  const m = /^\/p\/([^/]+)\//.exec(location.pathname);
  if (m) return decodeURIComponent(m[1]);
  return location.hostname.split('.')[0] || 'dev';
}

async function request(method, url, body, token) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw Object.assign(new Error((data && data.error) || `${res.status} ${res.statusText}`), { status: res.status, data });
  return data;
}

export function chroma({ project = detectProject(), origin = '', token } = {}) {
  const base = `${origin}/api`;
  const p = encodeURIComponent(project);
  const collection = (name) => {
    const url = `${base}/db/${p}/${encodeURIComponent(name)}`;
    return {
      /** list({ where: ['score:gte:10'], order: '-score', limit: 20, offset: 0 }) */
      list({ where = [], order, limit, offset } = {}) {
        const q = new URLSearchParams();
        for (const w of [].concat(where)) q.append('where', w);
        if (order) q.set('order', order);
        if (limit) q.set('limit', limit);
        if (offset) q.set('offset', offset);
        return request('GET', `${url}?${q}`, undefined, token);
      },
      get: (id) => request('GET', `${url}/${encodeURIComponent(id)}`, undefined, token).then((r) => r.doc),
      add: (doc) => request('POST', url, doc, token).then((r) => r.doc),
      set: (id, doc) => request('PUT', `${url}/${encodeURIComponent(id)}`, doc, token).then((r) => r.doc),
      update: (id, doc) => request('PATCH', `${url}/${encodeURIComponent(id)}`, doc, token).then((r) => r.doc),
      remove: (id) => request('DELETE', `${url}/${encodeURIComponent(id)}`, undefined, token),
      /** Realtime: callback({ type: 'add' | 'update' | 'delete' | 'clear', doc?, id? }). Returns an unsubscribe function. */
      subscribe(callback) {
        const es = new EventSource(`${url}/stream`);
        for (const type of ['add', 'update', 'delete', 'clear']) es.addEventListener(type, (e) => callback(JSON.parse(e.data)));
        return () => es.close();
      },
    };
  };
  return {
    project,
    db: collection,
    fn(name, { method = 'POST', body, query } = {}) {
      const q = query ? `?${new URLSearchParams(query)}` : '';
      return request(method, `${base}/fn/${p}/${name}${q}`, method === 'GET' ? undefined : body ?? {}, token);
    },
    track(name, { path = location.pathname } = {}) {
      return request('POST', `${base}/a/${p}/event`, { name, path }).catch(() => null);
    },
  };
}

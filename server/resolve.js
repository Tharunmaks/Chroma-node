// Maps a request path onto the files of a site (deployment or dev folder):
// exact file, folder index.html, clean URLs (/about -> about.html),
// optional single-page-app fallback, then 404.html.

export function normalizeRequestPath(raw) {
  let p;
  try { p = decodeURIComponent(raw || ''); } catch { return null; }
  p = p.replace(/^\/+/, '');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\\]/.test(p)) return null;
  const parts = p.split('/');
  if (parts.some((s) => s === '..' || s === '.' || (s.startsWith('.') && s !== ''))) return null;
  return p;
}

export function resolveSitePath(has, rawPath, { cleanUrls = true, spa = false } = {}) {
  const p = normalizeRequestPath(rawPath);
  if (p === null) return { path: has('404.html') ? '404.html' : null, status: 404 };
  const dir = p === '' || p.endsWith('/');
  const candidates = dir ? [`${p}index.html`] : [p, ...(cleanUrls ? [`${p}.html`, `${p}/index.html`] : [])];
  for (const c of candidates) if (has(c)) return { path: c, status: 200, redirect: !dir && c === `${p}/index.html` ? `${p.split('/').pop()}/` : null };
  if (spa && has('index.html') && !/\.[a-z0-9]+$/i.test(p)) return { path: 'index.html', status: 200 };
  return { path: has('404.html') ? '404.html' : null, status: 404 };
}

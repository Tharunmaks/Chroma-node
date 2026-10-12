#!/usr/bin/env node
// Builds a static live demo of the Chroma website (no server needed) for
// GitHub Pages or any static host:
//   node scripts/export-static.mjs dist --base=/Chroma-node/
// Everything that runs in the browser works (models, studio, playground,
// Torch notebook, engine, docs). Server features show a "run your own" note.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const out = path.resolve(args.find((a) => !a.startsWith('--')) || 'dist');
let base = (args.find((a) => a.startsWith('--base=')) || '--base=/').slice(7);
if (!base.startsWith('/')) base = `/${base}`;
if (!base.endsWith('/')) base += '/';

const PAGES = { '': 'index.html', models: 'models.html', studio: 'studio.html', playground: 'playground.html', torch: 'torch.html', platform: 'platform.html', docs: 'docs.html', dashboard: 'dashboard.html', engine: 'engine.html' };
const WEB = path.join(root, 'web');
const threeDir = path.resolve(path.dirname(require.resolve('three')), '..');
const pyreDir = path.dirname(require.resolve('pyre-lang'));

// root-absolute site paths -> base-prefixed paths (in quotes, attributes and template literals)
const SITE = 'assets|vendor|models|studio|playground|torch|platform|docs|dashboard|engine';
const rewrite = (text) => text
  .replace(new RegExp(`(["'\`(=])/(${SITE})(?=[/#?"'\`)]|$)`, 'gm'), `$1${base}$2`)
  .replace(/href="\/"/g, `href="${base}"`);

const ribbon = `<div class="demo-ribbon" role="note"><span><b>Live demo</b> · runs in your browser. Deploys, database &amp; analytics need your own server.</span><a class="btn small primary" href="https://github.com/Tharunmaks/Chroma-node">Get Chroma</a></div>`;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const [route, file] of Object.entries(PAGES)) {
  let html = fs.readFileSync(path.join(WEB, file), 'utf8')
    .replace(/<!--#(head|nav|footer)-->/g, (_, n) => fs.readFileSync(path.join(WEB, 'partials', `${n}.html`), 'utf8'));
  html = html.replace('<head>', '<head>\n<meta name="chroma-demo" content="1">');
  if (!['studio', 'playground'].includes(route)) html = html.replace('</body>', `${ribbon}\n</body>`);
  html = rewrite(html);
  const dest = route ? path.join(out, route, 'index.html') : path.join(out, 'index.html');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, html);
}
fs.copyFileSync(path.join(out, 'index.html'), path.join(out, '404.html'));

function copyTree(src, dest, { transform, skip } = {}) {
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (skip && skip(s)) continue;
    if (ent.isDirectory()) copyTree(s, d, { transform, skip });
    else {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      if (transform && /\.(js|css|html)$/.test(ent.name)) fs.writeFileSync(d, transform(fs.readFileSync(s, 'utf8')));
      else fs.copyFileSync(s, d);
    }
  }
}
copyTree(path.join(WEB, 'assets'), path.join(out, 'assets'), { transform: rewrite });
fs.mkdirSync(path.join(out, 'vendor', 'three'), { recursive: true });
fs.copyFileSync(path.join(threeDir, 'build', 'three.module.js'), path.join(out, 'vendor', 'three', 'three.module.js'));
copyTree(path.join(threeDir, 'examples', 'jsm'), path.join(out, 'vendor', 'three', 'addons'), { skip: (p) => /[/\\]libs$/.test(p) });
copyTree(pyreDir, path.join(out, 'vendor', 'pyre'), { skip: (p) => p.endsWith('png.js') });
fs.writeFileSync(path.join(out, '.nojekyll'), '');
fs.writeFileSync(path.join(out, 'robots.txt'), 'User-agent: *\nAllow: /\n');

let files = 0;
let bytes = 0;
const count = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) count(p); else { files++; bytes += fs.statSync(p).size; } } };
count(out);
console.log(`static demo: ${files} files, ${(bytes / 1048576).toFixed(1)} MB in ${path.relative(process.cwd(), out) || '.'} (base ${base})`);

// The Chroma build step: every .pyre file in a site is compiled with the
// Pyre compiler. Fragment shaders produce <name>.glsl and <name>.wgsl next to
// the source; kernels produce <name>.wgsl; every file gets <name>.pyre.json
// with metadata. Kernels inside api/ become HTTP functions.
import { compileAll, PyreError } from 'pyre-lang';
import { checkJsFunction } from './js-functions.js';

export function buildSite(files) {
  const outputs = new Map();
  const log = [];
  const functions = [];
  let ok = true;
  const add = (path, text, from) => {
    if (files.has(path)) {
      log.push({ level: 'warn', file: from, message: `skipped ${path}: a file with that name already exists` });
      return;
    }
    outputs.set(path, Buffer.from(text));
  };
  const pyreFiles = [...files.keys()].filter((p) => p.endsWith('.pyre')).sort();
  for (const path of pyreFiles) {
    const base = path.slice(0, -'.pyre'.length);
    try {
      const r = compileAll(files.get(path).toString('utf8'), { filename: path });
      if (r.glsl) add(`${base}.glsl`, r.glsl, path);
      if (r.wgsl) add(`${base}.wgsl`, r.wgsl, path);
      add(`${path}.json`, JSON.stringify({ meta: r.meta, glsl: r.glsl || null, wgsl: r.wgsl || null }), path);
      const what = r.meta.entry ? `@${r.meta.entry}` : 'library';
      log.push({ level: 'info', file: path, message: `compiled ${what} -> ${[r.glsl && 'glsl', r.wgsl && 'wgsl'].filter(Boolean).join(', ') || 'json'}` });
      if (r.meta.entry === 'kernel' && path.startsWith('api/')) {
        const name = path.slice(4, -'.pyre'.length);
        functions.push({ name, path, type: 'pyre' });
        log.push({ level: 'info', file: path, message: `function ready: POST /api/fn/<project>/${name}` });
      }
    } catch (err) {
      if (!(err instanceof PyreError)) throw err;
      ok = false;
      log.push({ level: 'error', file: path, message: err.format() });
    }
  }
  for (const path of [...files.keys()].filter((p) => /^api\/.+\.js$/.test(p)).sort()) {
    const problem = checkJsFunction(files.get(path).toString('utf8'), path);
    if (problem) {
      ok = false;
      log.push({ level: 'error', file: path, message: problem });
      continue;
    }
    const name = path.slice(4, -3);
    if (functions.some((f) => f.name === name)) {
      ok = false;
      log.push({ level: 'error', file: path, message: `api/${name}.pyre and api/${name}.js both define the function "${name}"` });
      continue;
    }
    functions.push({ name, path, type: 'js' });
    log.push({ level: 'info', file: path, message: `JS server function ready: /api/fn/<project>/${name}` });
  }
  if (!pyreFiles.length) log.push({ level: 'info', file: null, message: 'no .pyre files; static site' });
  return { ok, outputs, log, functions };
}

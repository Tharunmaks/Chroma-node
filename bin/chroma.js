#!/usr/bin/env node
// chroma — the Chroma command line: scaffold, develop, build and deploy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const CONFIG_DIR = process.env.CHROMA_CONFIG_DIR || path.join(os.homedir(), '.chroma');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const MAX_TOTAL = 50 * 1024 * 1024;
const MAX_FILE = 10 * 1024 * 1024;
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c(1), dim = c(2), red = c(31), green = c(32), yellow = c(33), cyan = c(36), magenta = c(35);

const HELP = `${bold('chroma')} ${VERSION} — deploy platform · Helix 3D engine · Pyre GPU language

${bold('Develop')}
  chroma init [dir] [--template helix-starter|static]   scaffold a site
  chroma dev [dir] [--port 5173]                        local server, live reload, Pyre compile
  chroma build [dir] [--out dist]                       compile .pyre files into a static folder
  chroma pyre <args>                                    run the Pyre compiler CLI

${bold('Deploy')}
  chroma login [--server URL] [--token TOKEN]           sign in (stores an API token)
  chroma deploy [dir] [--project name] [--preview]      upload, build and publish
  chroma projects                                       list your projects
  chroma deployments <project>                          list deployments
  chroma promote <project> <deployment-id>              point production at a deployment
  chroma rollback <project>                             promote the previous READY deployment
  chroma run <project> <function> [-u a=2] [-b x=1,2]   call a Pyre Function
  chroma whoami | chroma logout

${bold('Self-host')}
  chroma server [--port 3000] [--host 0.0.0.0]          start the Chroma platform

Environment: CHROMA_SERVER, CHROMA_TOKEN (for CI), NO_COLOR.`;

function die(msg) {
  console.error(`${red('✖')} ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { _: [], u: [], b: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) out[k] = argv[++i];
      else out[k] = true;
    } else if (a === '-u' || a === '-b') {
      if (i + 1 >= argv.length) die(`missing value for ${a}`);
      out[a.slice(1)].push(argv[++i]);
    } else if (a === '-h') out.help = true;
    else if (a === '-v') out.version = true;
    else out._.push(a);
  }
  return out;
}

// ---------- config ----------
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function writeConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(CONFIG_FILE, 0o600);
}
function session() {
  const cfg = readConfig();
  const server = (process.env.CHROMA_SERVER || cfg.server || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = process.env.CHROMA_TOKEN || cfg.token;
  return { server, token, user: cfg.user };
}

async function request(method, url, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    die(`cannot reach ${new URL(url).origin} (${err.cause?.code || err.message}). Is the server running? Try: chroma server`);
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return data;
}
async function authed(method, p, body) {
  const s = session();
  if (!s.token) die('not signed in. Run: chroma login');
  try {
    return await request(method, s.server + p, { token: s.token, body });
  } catch (err) {
    if (err.status === 401) die('your token is invalid or revoked. Run: chroma login');
    throw err;
  }
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); else if (!s.includes('\n')) rl.output.write('*'); };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

// ---------- files ----------
function loadIgnore(dir) {
  const file = path.join(dir, '.chromaignore');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((pat) => new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\/$/, '(/.*)?') + '$'));
}

function collectFiles(dir) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die(`${dir} is not a folder`);
  const ignore = loadIgnore(root);
  const files = [];
  let total = 0;
  const walk = (abs, rel) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (r === 'dist' && ent.isDirectory()) continue; // `chroma build` output; deploy it with `chroma deploy dist`
      if (ignore.some((re) => re.test(r))) continue;
      const a = path.join(abs, ent.name);
      if (ent.isSymbolicLink()) continue; // never follow links out of the project
      if (ent.isDirectory()) walk(a, r);
      else if (ent.isFile()) {
        const size = fs.statSync(a).size;
        if (size > MAX_FILE) die(`${r} is larger than 10 MB`);
        total += size;
        if (total > MAX_TOTAL) die('the site is larger than 50 MB');
        files.push({ path: r, abs: a, size });
      }
    }
  };
  walk(root, '');
  return files;
}

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function parseNums(text, what) {
  const parts = String(text).split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) die(`invalid numbers for ${what}: ${text}`);
  return parts.length === 1 ? parts[0] : parts;
}

function kv(list, what) {
  const out = {};
  for (const item of list) {
    const i = item.indexOf('=');
    if (i < 1) die(`${what} expects name=value, got ${item}`);
    out[item.slice(0, i)] = parseNums(item.slice(i + 1), item.slice(0, i));
  }
  return out;
}

// ---------- commands ----------
const commands = {
  async init(args) {
    const dir = args._[1] || 'my-site';
    const template = args.template || 'helix-starter';
    const src = path.join(ROOT, 'templates', template);
    if (!/^[a-z0-9-]+$/.test(template) || !fs.existsSync(path.join(src, 'template.json'))) {
      die(`unknown template '${template}'. Available: ${fs.readdirSync(path.join(ROOT, 'templates')).join(', ')}`);
    }
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) die(`${dir} already exists and is not empty`);
    fs.cpSync(src, dir, { recursive: true, filter: (p) => path.basename(p) !== 'template.json' });
    fs.writeFileSync(path.join(dir, 'chroma.json'), JSON.stringify({ name: path.basename(path.resolve(dir)).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'my-site', cleanUrls: true }, null, 2) + '\n');
    const list = collectFiles(dir).map((f) => f.path);
    console.log(`${green('✓')} created ${bold(dir)}/ ${dim(`(${list.join(', ')})`)}\n\n  cd ${dir}\n  chroma dev       ${dim('# http://localhost:5173 with live reload')}\n  chroma deploy    ${dim('# publish it')}\n`);
  },

  async dev(args) {
    const dir = args._[1] || '.';
    const { startDevServer } = await import('../server/dev.js');
    const { url } = await startDevServer({ dir, port: Number(args.port || 5173) });
    console.log(`\n  ${magenta('◆')} ${bold('chroma dev')} serving ${bold(path.resolve(dir))}\n    ${cyan(url)}  ${dim('· live reload · Pyre compiled on the fly · functions at /api/fn/dev/<name>')}\n`);
  },

  async build(args) {
    const dir = args._[1] || '.';
    const out = path.resolve(args.out || path.join(dir, 'dist'));
    const { buildSite } = await import('../server/build.js');
    const files = collectFiles(dir).filter((f) => !f.abs.startsWith(out + path.sep));
    const map = new Map(files.map((f) => [f.path, fs.readFileSync(f.abs)]));
    const result = buildSite(map);
    for (const l of result.log) console.log(`${l.level === 'error' ? red('error') : l.level === 'warn' ? yellow('warn ') : dim('info ')} ${l.file ? l.file + ': ' : ''}${l.message}`);
    if (!result.ok) die('build failed');
    fs.rmSync(out, { recursive: true, force: true });
    for (const [p, buf] of [...map, ...result.outputs]) {
      fs.mkdirSync(path.dirname(path.join(out, p)), { recursive: true });
      fs.writeFileSync(path.join(out, p), buf);
    }
    console.log(`${green('✓')} built ${map.size + result.outputs.size} files into ${bold(path.relative(process.cwd(), out) || '.')}`);
  },

  async pyre(args) {
    const require = createRequire(import.meta.url);
    const bin = path.join(path.dirname(require.resolve('pyre-lang/package.json')), 'bin', 'pyre.js');
    const child = spawn(process.execPath, [bin, ...process.argv.slice(3)], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 1));
  },

  async login(args) {
    const server = String(args.server || session().server).replace(/\/+$/, '');
    let token = typeof args.token === 'string' ? args.token : null;
    let user;
    if (token) {
      const me = await request('GET', `${server}/api/me`, { token }).catch((e) => die(e.message));
      if (!me.user) die('that token is not valid on this server');
      user = me.user.username;
    } else {
      if (!process.stdin.isTTY) die('no terminal for a password prompt; use: chroma login --token <token>');
      console.log(`Signing in to ${bold(server)}  ${dim('(create an account in the dashboard first)')}`);
      const username = (await ask('Username: ')).trim();
      const password = await ask('Password: ', { hidden: true });
      try {
        const res = await request('POST', `${server}/api/auth/token`, { body: { username, password, name: `cli@${os.hostname()}`.slice(0, 60) } });
        token = res.token;
        user = res.user.username;
      } catch (err) {
        die(err.message);
      }
    }
    writeConfig({ server, token, user });
    console.log(`${green('✓')} signed in as ${bold(user)} ${dim(`(token saved to ${CONFIG_FILE}, mode 600)`)}`);
  },

  async logout() {
    writeConfig({ server: session().server });
    console.log(`${green('✓')} signed out ${dim('(the token still exists on the server until you revoke it in the dashboard)')}`);
  },

  async whoami() {
    const s = session();
    const me = s.token ? await request('GET', `${s.server}/api/me`, { token: s.token }).catch(() => ({ user: null })) : { user: null };
    if (!me.user) die(`not signed in to ${s.server}`);
    console.log(`${bold(me.user.username)} on ${s.server}`);
  },

  async deploy(args) {
    const dir = args._[1] || '.';
    let name = args.project;
    const cfgFile = path.join(dir, 'chroma.json');
    if (!name && fs.existsSync(cfgFile)) {
      try { name = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).name; } catch { die('chroma.json is not valid JSON'); }
    }
    name = String(name || path.basename(path.resolve(dir))).toLowerCase();
    const files = collectFiles(dir);
    if (!files.length) die('nothing to deploy');
    const total = files.reduce((s, f) => s + f.size, 0);
    const s = session();
    try {
      await authed('GET', `/api/projects/${encodeURIComponent(name)}`);
    } catch (err) {
      if (err.status !== 404) die(err.message);
      await authed('POST', '/api/projects', { name }).catch((e) => die(e.message));
      console.log(`${green('✓')} created project ${bold(name)}`);
    }
    console.log(dim(`› uploading ${files.length} files (${fmtSize(total)})`));
    const started = Date.now();
    const body = { target: args.preview ? 'preview' : 'production', files: files.map((f) => ({ path: f.path, data: fs.readFileSync(f.abs).toString('base64') })) };
    let res;
    try {
      res = await authed('POST', `/api/projects/${encodeURIComponent(name)}/deployments`, body);
    } catch (err) {
      die(err.message);
    }
    const d = res.deployment;
    for (const l of d.log) {
      if (!l.file) continue;
      console.log(`${l.level === 'error' ? red('✖') : l.level === 'warn' ? yellow('!') : dim('›')} ${l.file}: ${l.level === 'error' ? l.message : dim(l.message)}`);
    }
    if (d.status !== 'READY') die(`build failed (${d.id}). Fix the errors above and deploy again.`);
    console.log(`${green('✓ READY')} in ${Date.now() - started} ms ${dim(`(build ${d.buildMs} ms)`)}`);
    if (!args.preview) console.log(`  production  ${cyan(s.server + res.production)}`);
    console.log(`  preview     ${cyan(s.server + d.url)}`);
    for (const f of d.functions) console.log(`  function    ${cyan(`POST ${s.server}/api/fn/${name}/${f}`)}`);
  },

  async projects() {
    const { projects } = await authed('GET', '/api/projects');
    if (!projects.length) return console.log(dim('no projects yet — chroma deploy creates one'));
    const s = session();
    for (const p of projects) {
      const st = p.latest ? (p.latest.status === 'READY' ? green(p.latest.status) : red(p.latest.status)) : dim('empty');
      console.log(`${bold(p.name.padEnd(28))} ${st.padEnd(tty ? 16 : 7)} ${p.production ? cyan(s.server + p.url) : dim('not live')}`);
    }
  },

  async deployments(args) {
    const name = args._[1] || die('usage: chroma deployments <project>');
    const { deployments } = await authed('GET', `/api/projects/${encodeURIComponent(name)}`).catch((e) => die(e.message));
    for (const d of deployments) {
      console.log(`${d.production ? green('●') : ' '} ${d.id}  ${(d.status === 'READY' ? green : red)(d.status.padEnd(5))}  ${dim(new Date(d.createdAt).toLocaleString())}  ${dim(`${d.fileCount} files · ${fmtSize(d.size)} · ${d.source}`)}`);
    }
  },

  async promote(args) {
    const [, name, id] = args._;
    if (!name || !id) die('usage: chroma promote <project> <deployment-id>');
    await authed('POST', `/api/projects/${encodeURIComponent(name)}/promote`, { deploymentId: id }).catch((e) => die(e.message));
    console.log(`${green('✓')} production for ${bold(name)} now serves ${id}`);
  },

  async rollback(args) {
    const name = args._[1] || die('usage: chroma rollback <project>');
    const { deployments } = await authed('GET', `/api/projects/${encodeURIComponent(name)}`).catch((e) => die(e.message));
    const i = deployments.findIndex((d) => d.production);
    const prev = deployments.slice(i + 1).find((d) => d.status === 'READY');
    if (!prev) die('there is no earlier READY deployment to roll back to');
    await authed('POST', `/api/projects/${encodeURIComponent(name)}/promote`, { deploymentId: prev.id });
    console.log(`${green('✓')} rolled ${bold(name)} back to ${prev.id} ${dim(`(${new Date(prev.createdAt).toLocaleString()})`)}`);
  },

  async run(args) {
    const [, name, fn] = args._;
    if (!name || !fn) die('usage: chroma run <project> <function> [-u name=value] [-b name=1,2,3|length]');
    const s = session();
    const buffers = kv(args.b, '-b');
    const body = { uniforms: kv(args.u, "-u"), buffers };
    if (args.count) body.count = Number(args.count);
    const res = await request('POST', `${s.server}/api/fn/${encodeURIComponent(name)}/${fn}`, { body }).catch((e) => die(e.message));
    for (const [k, v] of Object.entries(res.buffers)) console.log(`${bold(k)} = [${v.join(', ')}]`);
    console.log(dim(`${res.ms} ms`));
  },

  async server(args) {
    const { startServer } = await import('../server/index.js');
    const { url } = await startServer({ port: args.port ? Number(args.port) : undefined, host: args.host });
    console.log(`\n  ${magenta('◆')} ${bold('Chroma')} ${VERSION} running at ${cyan(url)}\n    dashboard ${url}/dashboard · playground ${url}/playground\n`);
  },
};

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (args.version) { console.log(VERSION); process.exit(0); }
if (!cmd || args.help || cmd === 'help') { console.log(HELP); process.exit(0); }
if (!Object.hasOwn(commands, cmd)) die(`unknown command '${cmd}'. Run chroma --help`);
await commands[cmd](args);

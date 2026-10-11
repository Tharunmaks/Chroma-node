// Shared front-end helpers: navigation, scroll reveals, copy buttons, the
// Pyre syntax highlighter, toasts and an API client that handles CSRF.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Build DOM safely: h('div', { class: 'x', onclick }, 'text', child). Strings are text, never HTML. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// ---------- Pyre syntax highlighting ----------
const KEYWORDS = new Set('fn let var const if elif else for in while return break continue pass and or not true false uniform buffer range'.split(' '));
const TYPES = new Set('bool int float vec2 vec3 vec4 mat2 mat3 mat4'.split(' '));
const TOKEN = /(#.*$)|(@\w+)|(\b0x[0-9a-fA-F]+\b|\b\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?\b|\.\d+\b)|([A-Za-z_]\w*)(?=\s*\()|([A-Za-z_]\w*)/gm;

export function highlightPyre(src) {
  let out = '';
  let last = 0;
  for (const m of src.matchAll(TOKEN)) {
    out += escapeHtml(src.slice(last, m.index));
    last = m.index + m[0].length;
    const [text, com, dec, num, call, word] = m;
    if (com) out += `<span class="c">${escapeHtml(com)}</span>`;
    else if (dec) out += `<span class="d">${dec}</span>`;
    else if (num) out += `<span class="n">${num}</span>`;
    else {
      const w = call || word;
      if (KEYWORDS.has(w)) out += `<span class="k">${w}</span>`;
      else if (TYPES.has(w)) out += `<span class="ty">${w}</span>`;
      else if (call) out += `<span class="f">${w}</span>`;
      else out += text;
    }
  }
  return out + escapeHtml(src.slice(last));
}

const C_KEYWORDS = new Set('fn let var const if else for while return break continue struct uniform in out precision highp void true false select'.split(' '));
const C_TYPES = /^(float|int|bool|u32|i32|f32|vec[234](<f32>)?|mat[234](x[234])?(<f32>)?|ivec[234]|array)$/;
/** Lightweight highlighter for generated GLSL / WGSL / JS. */
export function highlightC(src) {
  let out = '';
  let last = 0;
  const re = /(\/\/.*$)|(@\w+|#version.*$|#\w+)|(\b\d+\.?\d*(?:e[+-]?\d+)?\b)|([A-Za-z_$][\w$]*(?:<f32>)?)(?=\s*\()|([A-Za-z_$][\w$]*(?:<f32>)?)/gm;
  for (const m of src.matchAll(re)) {
    out += escapeHtml(src.slice(last, m.index));
    last = m.index + m[0].length;
    const [text, com, dec, num, call, word] = m;
    if (com) out += `<span class="c">${escapeHtml(com)}</span>`;
    else if (dec) out += `<span class="d">${escapeHtml(dec)}</span>`;
    else if (num) out += `<span class="n">${num}</span>`;
    else {
      const w = call || word;
      if (C_TYPES.test(w)) out += `<span class="ty">${escapeHtml(w)}</span>`;
      else if (C_KEYWORDS.has(w)) out += `<span class="k">${w}</span>`;
      else if (call) out += `<span class="f">${escapeHtml(w)}</span>`;
      else out += escapeHtml(text);
    }
  }
  return out + escapeHtml(src.slice(last));
}

// ---------- API client ----------
let csrf = null;
let mePromise = null;

export function me(force = false) {
  if (!mePromise || force) {
    mePromise = fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json()).then((d) => {
      csrf = d.csrf || null;
      return d;
    }).catch(() => ({ user: null }));
  }
  return mePromise;
}

export function setCsrf(token) { csrf = token; }

export async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- UI bits ----------
export function toast(message, kind = 'ok', ms = 3800) {
  let box = $('.toast');
  if (!box) { box = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const el = h('div', { class: kind }, message);
  box.append(el);
  setTimeout(() => el.remove(), ms);
}

export async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', {}, text);
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  if (button) {
    const prev = button.textContent;
    button.textContent = 'Copied';
    button.classList.add('done');
    setTimeout(() => { button.textContent = prev; button.classList.remove('done'); }, 1400);
  }
}

function initNav() {
  const nav = $('.nav');
  if (!nav) return;
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
  const btn = $('.menu-btn', nav);
  if (btn) btn.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
  });
  const here = location.pathname.replace(/\/$/, '') || '/';
  for (const a of $$('.nav-links a', nav)) if (a.getAttribute('href') === here) a.setAttribute('aria-current', 'page');
  const account = $('[data-account]', nav);
  if (account) {
    me().then((d) => {
      if (d.user) {
        account.textContent = 'Dashboard';
        account.setAttribute('href', '/dashboard');
      }
    });
  }
}

function initReveal() {
  const els = $$('.reveal');
  if (!('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('in')); return; }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  els.forEach((e) => io.observe(e));
}

function initCopy() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (b) copyText(b.dataset.copy || b.closest('[data-copy-root]')?.querySelector('code')?.textContent || '', b);
  });
}

/** Subtle 3D tilt on hover for cards marked .tilt (disabled for reduced motion / touch). */
function initTilt() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || matchMedia('(hover: none)').matches) return;
  for (const el of $$('.tilt')) {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      el.style.transform = `perspective(900px) rotateX(${(-y * 6).toFixed(2)}deg) rotateY(${(x * 8).toFixed(2)}deg) translateY(-2px)`;
    });
    el.addEventListener('pointerleave', () => { el.style.transform = ''; });
  }
}

initNav();
initReveal();
initCopy();
initTilt();

const JS_KEYWORDS = new Set('const let var function return if else for of in while do break continue new class extends await async import from export default try catch finally throw typeof instanceof this null undefined true false yield switch case'.split(' '));
/** Small JavaScript highlighter (comments, strings, numbers, keywords, calls). */
export function highlightJS(src) {
  let out = '';
  let last = 0;
  const re = /(\/\/.*$|\/\*[\s\S]*?\*\/)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b\d[\d_]*\.?\d*(?:e[+-]?\d+)?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/gm;
  for (const m of src.matchAll(re)) {
    out += escapeHtml(src.slice(last, m.index));
    last = m.index + m[0].length;
    const [text, com, strl, num, call, word] = m;
    if (com) out += `<span class="c">${escapeHtml(com)}</span>`;
    else if (strl) out += `<span class="s">${escapeHtml(strl)}</span>`;
    else if (num) out += `<span class="n">${num}</span>`;
    else if (JS_KEYWORDS.has(call || word)) out += `<span class="k">${call || word}</span>`;
    else if (call) out += `<span class="f">${escapeHtml(call)}</span>`;
    else out += escapeHtml(text);
  }
  return out + escapeHtml(src.slice(last));
}

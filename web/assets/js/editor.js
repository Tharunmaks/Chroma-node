// A small code editor: textarea + highlighted overlay + line numbers.
// Python-style editing: auto-indent after ':', Tab / Shift+Tab, Ctrl+/ comments.
import { highlightPyre } from './common.js';

export class Editor {
  constructor(root, { value = '', onChange, onRun } = {}) {
    this.root = root;
    root.classList.add('editor');
    this.gutter = document.createElement('div');
    this.gutter.className = 'gutter';
    this.gutter.setAttribute('aria-hidden', 'true');
    const area = document.createElement('div');
    area.className = 'area';
    this.pre = document.createElement('pre');
    this.pre.setAttribute('aria-hidden', 'true');
    this.ta = document.createElement('textarea');
    this.ta.spellcheck = false;
    this.ta.autocapitalize = 'off';
    this.ta.setAttribute('autocorrect', 'off');
    this.ta.setAttribute('aria-label', 'Pyre source code');
    area.append(this.pre, this.ta);
    root.append(this.gutter, area);
    this.errorLine = 0;
    this.onChange = onChange;
    this.onRun = onRun;
    this.ta.value = value;
    this.ta.addEventListener('input', () => { this.render(); this.onChange?.(this.value); });
    this.ta.addEventListener('scroll', () => this.sync());
    this.ta.addEventListener('keydown', (e) => this.key(e));
    this.render();
  }

  get value() { return this.ta.value; }
  set value(v) { this.ta.value = v; this.render(); }

  setError(line) {
    this.errorLine = line || 0;
    this.render();
  }

  render() {
    const lines = this.ta.value.split('\n');
    const html = highlightPyre(this.ta.value).split('\n');
    if (this.errorLine > 0 && this.errorLine <= html.length) html[this.errorLine - 1] = `<span class="errline">${html[this.errorLine - 1] || ' '}</span>`;
    this.pre.innerHTML = html.join('\n') + '\n';
    this.gutter.innerHTML = lines.map((_, i) => (i + 1 === this.errorLine ? `<span class="bad">${i + 1}</span>` : String(i + 1))).join('\n') + '\n';
    this.sync();
  }

  sync() {
    this.pre.scrollTop = this.ta.scrollTop;
    this.pre.scrollLeft = this.ta.scrollLeft;
    this.gutter.scrollTop = this.ta.scrollTop;
  }

  replaceRange(start, end, text, selStart, selEnd) {
    this.ta.setSelectionRange(start, end);
    // execCommand keeps the browser's undo stack working
    if (!document.execCommand('insertText', false, text)) {
      this.ta.setRangeText(text, start, end, 'end');
      this.ta.dispatchEvent(new Event('input'));
    }
    if (selStart !== undefined) this.ta.setSelectionRange(selStart, selEnd ?? selStart);
  }

  key(e) {
    const ta = this.ta;
    const { selectionStart: s, selectionEnd: t, value: v } = ta;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); this.onRun?.(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      if (s === t && !e.shiftKey) { this.replaceRange(s, t, '    '); return; }
      const end = t > s && v[t - 1] === '\n' ? t - 1 : t;
      const block = v.slice(lineStart, end);
      const changed = e.shiftKey
        ? block.split('\n').map((l) => l.replace(/^ {1,4}/, '')).join('\n')
        : block.split('\n').map((l) => '    ' + l).join('\n');
      this.replaceRange(lineStart, end, changed, lineStart, lineStart + changed.length);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      const line = v.slice(lineStart, s);
      let indent = line.match(/^ */)[0];
      if (/:\s*(#.*)?$/.test(line)) indent += '    ';
      else if (/^\s*(return|break|continue|pass)\b/.test(line)) indent = indent.slice(4);
      this.replaceRange(s, t, '\n' + indent);
      return;
    }
    if (e.key === 'Backspace' && s === t) {
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      const before = v.slice(lineStart, s);
      if (before.length && /^ +$/.test(before) && before.length % 4 === 0) {
        e.preventDefault();
        this.replaceRange(s - 4, s, '');
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === '/') {
      e.preventDefault();
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      let lineEnd = v.indexOf('\n', t);
      if (lineEnd < 0) lineEnd = v.length;
      const lines = v.slice(lineStart, lineEnd).split('\n');
      const allCommented = lines.every((l) => /^\s*#/.test(l) || !l.trim());
      const out = lines.map((l) => (allCommented ? l.replace(/^(\s*)# ?/, '$1') : l.replace(/^(\s*)/, '$1# '))).join('\n');
      this.replaceRange(lineStart, lineEnd, out, lineStart, lineStart + out.length);
    }
  }
}

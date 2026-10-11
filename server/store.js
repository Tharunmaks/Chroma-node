// Persistent storage: a JSON document database written atomically, plus a
// content-addressed blob store (files are stored once by SHA-256).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sha256 } from './security.js';

const EMPTY = () => ({ version: 1, users: {}, sessions: {}, tokens: {}, projects: {}, deployments: {}, audit: [] });
const MAX_AUDIT = 5000;

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.blobDir = path.join(dir, 'blobs');
    fs.mkdirSync(this.blobDir, { recursive: true, mode: 0o700 });
    this.data = EMPTY();
    if (fs.existsSync(this.file)) {
      this.data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    }
    this.dirty = false;
    this.timer = null;
  }

  /** Mark data as changed; writes are batched and atomic (tmp file + rename). */
  save() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 50);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  id(prefix) {
    return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
  }

  audit(event, { userId = null, ip = null, detail = null } = {}) {
    this.data.audit.push({ at: new Date().toISOString(), event, userId, ip, detail });
    if (this.data.audit.length > MAX_AUDIT) this.data.audit.splice(0, this.data.audit.length - MAX_AUDIT);
    this.save();
  }

  // ---- blobs ----
  blobPath(hash) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('bad blob hash');
    return path.join(this.blobDir, hash.slice(0, 2), hash.slice(2));
  }

  putBlob(buf) {
    const hash = sha256(buf);
    const file = this.blobPath(hash);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buf, { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
    return hash;
  }

  getBlob(hash) {
    return fs.readFileSync(this.blobPath(hash));
  }

  /** Delete blobs no deployment references any more. */
  gcBlobs() {
    const live = new Set();
    for (const d of Object.values(this.data.deployments)) for (const f of Object.values(d.files)) live.add(f.hash);
    let removed = 0;
    for (const sub of fs.readdirSync(this.blobDir)) {
      const subdir = path.join(this.blobDir, sub);
      for (const name of fs.readdirSync(subdir)) {
        if (!live.has(sub + name)) { fs.rmSync(path.join(subdir, name), { force: true }); removed++; }
      }
    }
    return removed;
  }

  close() { this.flush(); }
}

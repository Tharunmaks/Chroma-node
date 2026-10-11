// Saved models: a user's own parametric models (catalog presets they edited)
// and Pyre-defined surfaces, optionally shared in the public gallery.
import crypto from 'node:crypto';
import { HttpError } from './http.js';

export const MODEL_FAMILIES = new Set(['supershape', 'knot', 'harmonic', 'lissajous', 'superquadric', 'shell', 'surface', 'polyhedron', 'polytope', 'duoprism', 'clifford', 'hypershape', 'pyre']);
const MAX_PER_USER = 500;

function cleanParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new HttpError(400, 'params must be an object');
  const entries = Object.entries(params);
  if (entries.length > 32) throw new HttpError(400, 'too many params');
  const out = {};
  for (const [k, v] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k)) throw new HttpError(400, `invalid param name ${k.slice(0, 32)}`);
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && v.length <= 32) out[k] = v;
    else throw new HttpError(400, `param ${k} must be a finite number or short string`);
  }
  return out;
}

export class Models {
  constructor(sql) {
    this.sql = sql;
    this.s = {
      mine: sql.prepare('SELECT * FROM models WHERE user_id = ? ORDER BY updated DESC LIMIT 500'),
      count: sql.prepare('SELECT COUNT(*) AS n FROM models WHERE user_id = ?'),
      get: sql.prepare('SELECT * FROM models WHERE id = ?'),
      insert: sql.prepare('INSERT INTO models (id, user_id, name, family, params, source, public, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      update: sql.prepare('UPDATE models SET name = ?, family = ?, params = ?, source = ?, public = ?, updated = ? WHERE id = ?'),
      remove: sql.prepare('DELETE FROM models WHERE id = ?'),
      gallery: sql.prepare('SELECT m.*, ? AS dummy FROM models m WHERE public = 1 ORDER BY updated DESC LIMIT ? OFFSET ?'),
      galleryCount: sql.prepare('SELECT COUNT(*) AS n FROM models WHERE public = 1'),
      removeUser: sql.prepare('DELETE FROM models WHERE user_id = ?'),
    };
  }

  validate(body) {
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 80) throw new HttpError(400, 'name must be 1-80 characters');
    const family = String(body.family || '');
    if (!MODEL_FAMILIES.has(family)) throw new HttpError(400, 'unknown model family');
    const params = cleanParams(body.params || {});
    let source = null;
    if (family === 'pyre') {
      source = String(body.source || '');
      if (!source || source.length > 32 * 1024) throw new HttpError(400, 'Pyre models need source code (up to 32 KB)');
    }
    return { name, family, params, source, public: body.public ? 1 : 0 };
  }

  view(row, usernames) {
    return {
      id: row.id, name: row.name, family: row.family, params: JSON.parse(row.params), source: row.source,
      public: !!row.public, created: row.created, updated: row.updated, author: usernames ? usernames(row.user_id) : undefined,
    };
  }

  list(userId) { return this.s.mine.all(userId).map((r) => this.view(r)); }

  create(userId, body) {
    if (this.s.count.get(userId).n >= MAX_PER_USER) throw new HttpError(403, `limit of ${MAX_PER_USER} saved models reached`);
    const m = this.validate(body);
    const id = `mdl_${crypto.randomBytes(9).toString('base64url')}`;
    const now = Date.now();
    this.s.insert.run(id, userId, m.name, m.family, JSON.stringify(m.params), m.source, m.public, now, now);
    return this.view(this.s.get.get(id));
  }

  /** Owner sees everything; anyone can see public models. */
  get(id, userId, usernames) {
    const row = this.s.get.get(String(id));
    if (!row || (!row.public && row.user_id !== userId)) throw new HttpError(404, 'model not found');
    return this.view(row, usernames);
  }

  update(id, userId, body) {
    const row = this.s.get.get(String(id));
    if (!row || row.user_id !== userId) throw new HttpError(404, 'model not found');
    const m = this.validate({ ...this.view(row), ...body });
    this.s.update.run(m.name, m.family, JSON.stringify(m.params), m.source, m.public, Date.now(), row.id);
    return this.view(this.s.get.get(row.id));
  }

  remove(id, userId) {
    const row = this.s.get.get(String(id));
    if (!row || row.user_id !== userId) throw new HttpError(404, 'model not found');
    this.s.remove.run(row.id);
  }

  gallery({ limit = 48, offset = 0 } = {}, usernames) {
    const l = Math.min(100, Math.max(1, Number(limit) || 48));
    const o = Math.max(0, Number(offset) || 0);
    return { models: this.s.gallery.all(0, l, o).map((r) => this.view(r, usernames)), total: this.s.galleryCount.get().n };
  }
}

// Chroma Database: JSON document collections per project, stored in SQLite,
// with per-collection access rules, queries and real-time change streams.
//
// Rules (per collection):
//   read:  'public'  — anyone (deployed pages) can list and get documents
//          'private' — only the owner (dashboard session or API token)
//   write: 'public'  — anyone can create, update and delete
//          'create'  — anyone can add documents but not change them (forms, guestbooks)
//          'private' — only the owner
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { HttpError } from './http.js';

export const DB_LIMITS = { collections: 50, docsPerCollection: 10_000, docBytes: 16 * 1024, pageSize: 100 };
const COLLECTION_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DOC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OPS = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const READ_RULES = ['public', 'private'];
const WRITE_RULES = ['public', 'create', 'private'];

function checkValue(value, depth = 0) {
  if (depth > 8) throw new HttpError(400, 'document is nested too deeply');
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return;
  if (typeof value === 'string') return;
  if (Array.isArray(value)) { value.forEach((v) => checkValue(v, depth + 1)); return; }
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) {
      if (k.startsWith('_') || k === 'constructor' || k === 'prototype' || k.length > 64) throw new HttpError(400, `field name "${k.slice(0, 40)}" is not allowed`);
      checkValue(value[k], depth + 1);
    }
    return;
  }
  throw new HttpError(400, 'unsupported value in document');
}

export class ProjectDatabase extends EventEmitter {
  constructor(sql) {
    super();
    this.setMaxListeners(0);
    this.sql = sql;
    this.s = {
      getCol: sql.prepare('SELECT * FROM collections WHERE project_id = ? AND name = ?'),
      listCols: sql.prepare('SELECT c.name, c.read_rule, c.write_rule, c.created, (SELECT COUNT(*) FROM docs d WHERE d.project_id = c.project_id AND d.collection = c.name) AS count FROM collections c WHERE c.project_id = ? ORDER BY c.name'),
      countCols: sql.prepare('SELECT COUNT(*) AS n FROM collections WHERE project_id = ?'),
      addCol: sql.prepare('INSERT INTO collections (project_id, name, read_rule, write_rule, created) VALUES (?, ?, ?, ?, ?)'),
      setRules: sql.prepare('UPDATE collections SET read_rule = ?, write_rule = ? WHERE project_id = ? AND name = ?'),
      dropCol: sql.prepare('DELETE FROM collections WHERE project_id = ? AND name = ?'),
      dropDocs: sql.prepare('DELETE FROM docs WHERE project_id = ? AND collection = ?'),
      count: sql.prepare('SELECT COUNT(*) AS n FROM docs WHERE project_id = ? AND collection = ?'),
      get: sql.prepare('SELECT * FROM docs WHERE project_id = ? AND collection = ? AND id = ?'),
      insert: sql.prepare('INSERT INTO docs (project_id, collection, id, data, created, updated) VALUES (?, ?, ?, ?, ?, ?)'),
      update: sql.prepare('UPDATE docs SET data = ?, updated = ? WHERE project_id = ? AND collection = ? AND id = ?'),
      remove: sql.prepare('DELETE FROM docs WHERE project_id = ? AND collection = ? AND id = ?'),
      dropProject: sql.prepare('DELETE FROM docs WHERE project_id = ?'),
      dropProjectCols: sql.prepare('DELETE FROM collections WHERE project_id = ?'),
    };
  }

  collections(projectId) {
    return this.s.listCols.all(projectId).map((c) => ({ name: c.name, read: c.read_rule, write: c.write_rule, count: c.count, created: c.created }));
  }

  collection(projectId, name, { create = false } = {}) {
    if (!COLLECTION_RE.test(String(name))) throw new HttpError(400, 'collection names use 1-40 lowercase letters, digits, - and _');
    let c = this.s.getCol.get(projectId, name);
    if (!c && create) {
      if (this.s.countCols.get(projectId).n >= DB_LIMITS.collections) throw new HttpError(403, `limit of ${DB_LIMITS.collections} collections reached`);
      this.s.addCol.run(projectId, name, 'private', 'private', Date.now());
      c = this.s.getCol.get(projectId, name);
    }
    if (!c) throw new HttpError(404, 'collection not found');
    return c;
  }

  setRules(projectId, name, { read, write }) {
    const c = this.collection(projectId, name, { create: true });
    const r = read ?? c.read_rule;
    const w = write ?? c.write_rule;
    if (!READ_RULES.includes(r)) throw new HttpError(400, `read must be one of ${READ_RULES.join(', ')}`);
    if (!WRITE_RULES.includes(w)) throw new HttpError(400, `write must be one of ${WRITE_RULES.join(', ')}`);
    this.s.setRules.run(r, w, projectId, name);
    return { name, read: r, write: w };
  }

  dropCollection(projectId, name) {
    this.collection(projectId, name);
    this.s.dropDocs.run(projectId, name);
    this.s.dropCol.run(projectId, name);
    this.emit(`${projectId}/${name}`, { type: 'clear' });
  }

  dropProject(projectId) {
    this.s.dropProject.run(projectId);
    this.s.dropProjectCols.run(projectId);
  }

  /** Throws unless the caller may perform `action` (read | create | write). */
  authorize(col, action, isOwner) {
    if (isOwner) return;
    if (action === 'read' && col.read_rule === 'public') return;
    if (action === 'create' && (col.write_rule === 'public' || col.write_rule === 'create')) return;
    if (action === 'write' && col.write_rule === 'public') return;
    throw new HttpError(403, `this collection does not allow public ${action === 'read' ? 'reads' : 'writes'}`);
  }

  view(row) {
    return { _id: row.id, _created: row.created, _updated: row.updated, ...JSON.parse(row.data) };
  }

  encode(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'a document must be a JSON object');
    const clean = Object.fromEntries(Object.entries(body).filter(([k]) => !['_id', '_created', '_updated'].includes(k)));
    checkValue(clean);
    const json = JSON.stringify(clean);
    if (Buffer.byteLength(json) > DB_LIMITS.docBytes) throw new HttpError(413, `documents are limited to ${DB_LIMITS.docBytes / 1024} KB`);
    return json;
  }

  add(projectId, name, body) {
    const data = this.encode(body);
    if (this.s.count.get(projectId, name).n >= DB_LIMITS.docsPerCollection) throw new HttpError(403, `collection is full (${DB_LIMITS.docsPerCollection} documents)`);
    const id = crypto.randomBytes(9).toString('base64url');
    const now = Date.now();
    this.s.insert.run(projectId, name, id, data, now, now);
    const doc = this.view(this.s.get.get(projectId, name, id));
    this.emit(`${projectId}/${name}`, { type: 'add', doc });
    return doc;
  }

  get(projectId, name, id) {
    if (!DOC_ID_RE.test(String(id))) throw new HttpError(400, 'invalid document id');
    const row = this.s.get.get(projectId, name, id);
    if (!row) throw new HttpError(404, 'document not found');
    return this.view(row);
  }

  set(projectId, name, id, body, { merge = false } = {}) {
    if (!DOC_ID_RE.test(String(id))) throw new HttpError(400, 'invalid document id');
    const row = this.s.get.get(projectId, name, id);
    const next = merge && row ? { ...JSON.parse(row.data), ...body } : body;
    const data = this.encode(next);
    const now = Date.now();
    if (row) this.s.update.run(data, now, projectId, name, id);
    else {
      if (this.s.count.get(projectId, name).n >= DB_LIMITS.docsPerCollection) throw new HttpError(403, 'collection is full');
      this.s.insert.run(projectId, name, id, data, now, now);
    }
    const doc = this.view(this.s.get.get(projectId, name, id));
    this.emit(`${projectId}/${name}`, { type: row ? 'update' : 'add', doc });
    return doc;
  }

  remove(projectId, name, id) {
    if (!DOC_ID_RE.test(String(id))) throw new HttpError(400, 'invalid document id');
    const r = this.s.remove.run(projectId, name, id);
    if (!r.changes) throw new HttpError(404, 'document not found');
    this.emit(`${projectId}/${name}`, { type: 'delete', id });
  }

  /**
   * List documents. Query params: where=field:op:value (repeatable),
   * order=field or -field, limit (1-100), offset.
   */
  query(projectId, name, params) {
    const args = [projectId, name];
    let sql = 'SELECT * FROM docs WHERE project_id = ? AND collection = ?';
    for (const w of [].concat(params.where || [])) {
      const [field, op, ...rest] = String(w).split(':');
      const raw = rest.join(':');
      if (!FIELD_RE.test(field) || !(op in OPS || op === 'contains')) throw new HttpError(400, `invalid filter "${String(w).slice(0, 60)}" (use field:op:value with eq, ne, gt, gte, lt, lte, contains)`);
      if (op === 'contains') {
        sql += " AND instr(lower(CAST(json_extract(data, ?) AS TEXT)), lower(?)) > 0";
        args.push(`$.${field}`, raw);
      } else {
        const value = raw === 'true' ? 1 : raw === 'false' ? 0 : raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
        sql += ` AND json_extract(data, ?) ${OPS[op]} ?`;
        args.push(`$.${field}`, value);
      }
    }
    const order = String(params.order || '-_created');
    const desc = order.startsWith('-');
    const key = order.replace(/^-/, '');
    if (key === '_created' || key === '_updated') sql += ` ORDER BY ${key === '_created' ? 'created' : 'updated'} ${desc ? 'DESC' : 'ASC'}`;
    else if (FIELD_RE.test(key)) { sql += ` ORDER BY json_extract(data, ?) ${desc ? 'DESC' : 'ASC'}`; args.push(`$.${key}`); } else throw new HttpError(400, 'invalid order field');
    const limit = Math.min(DB_LIMITS.pageSize, Math.max(1, Number(params.limit) || 50));
    const offset = Math.max(0, Math.min(1e6, Number(params.offset) || 0));
    sql += ' LIMIT ? OFFSET ?';
    args.push(limit, offset);
    const docs = this.sql.prepare(sql).all(...args).map((r) => this.view(r));
    return { docs, total: this.s.count.get(projectId, name).n, limit, offset };
  }
}

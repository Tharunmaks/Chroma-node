// Privacy-friendly, real-time analytics for deployed projects.
// No cookies and no raw IPs are stored: a visitor is an HMAC of
// (ip, user agent, project) with a salt that rotates every day.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tx } from './sqlite.js';

const RANGES = { '1h': [3600e3, 60e3], '24h': [86400e3, 3600e3], '7d': [7 * 86400e3, 6 * 3600e3], '30d': [30 * 86400e3, 86400e3] };
const RETENTION = 31 * 86400e3;

export function deviceOf(ua = '') {
  const s = ua.toLowerCase();
  if (/bot|crawl|spider|slurp|curl|wget|python|node-fetch|undici|headless/.test(s)) return 'bot';
  if (/ipad|tablet/.test(s)) return 'tablet';
  if (/mobi|iphone|android/.test(s)) return 'mobile';
  return 'desktop';
}

export function browserOf(ua = '') {
  if (/edg\//i.test(ua)) return 'Edge';
  if (/chrome|crios/i.test(ua)) return 'Chrome';
  if (/firefox|fxios/i.test(ua)) return 'Firefox';
  if (/safari/i.test(ua)) return 'Safari';
  return 'Other';
}

export class Analytics extends EventEmitter {
  constructor(db) {
    super();
    this.setMaxListeners(0);
    this.db = db;
    this.queue = [];
    this.insert = db.prepare('INSERT INTO events (project_id, ts, kind, path, status, ms, bytes, ref, device, visitor, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.flushTimer = setInterval(() => this.flush(), 400);
    this.flushTimer.unref();
    this.pruneTimer = setInterval(() => this.prune(), 3600e3);
    this.pruneTimer.unref();
    this.salts = new Map();
  }

  salt(day) {
    if (this.salts.has(day)) return this.salts.get(day);
    let row = this.db.prepare('SELECT salt FROM salts WHERE day = ?').get(day);
    if (!row) {
      const salt = crypto.randomBytes(16).toString('hex');
      this.db.prepare('INSERT OR IGNORE INTO salts (day, salt) VALUES (?, ?)').run(day, salt);
      this.db.prepare('DELETE FROM salts WHERE day < ?').run(new Date(Date.now() - 2 * 86400e3).toISOString().slice(0, 10));
      row = this.db.prepare('SELECT salt FROM salts WHERE day = ?').get(day);
    }
    this.salts.set(day, row.salt);
    if (this.salts.size > 3) this.salts.delete(this.salts.keys().next().value);
    return row.salt;
  }

  visitor(projectId, ip, ua) {
    const day = new Date().toISOString().slice(0, 10);
    return crypto.createHmac('sha256', this.salt(day)).update(`${projectId}|${ip}|${ua}`).digest('hex').slice(0, 16);
  }

  /** Record one event; it is visible to live viewers immediately and persisted within ~0.4 s. */
  record(projectId, { kind, path = null, status = null, ms = null, bytes = null, ref = null, ip = '', ua = '', name = null, host = '' }) {
    let refHost = null;
    if (ref) {
      try {
        const u = new URL(ref);
        if (u.host !== host) refHost = u.host.slice(0, 120);
      } catch { /* ignore malformed referrers */ }
    }
    const ev = {
      projectId, ts: Date.now(), kind, path: path ? String(path).slice(0, 300) : null, status, ms: ms === null ? null : Math.round(ms * 10) / 10,
      bytes, ref: refHost, device: deviceOf(ua), visitor: this.visitor(projectId, ip, ua), name: name ? String(name).slice(0, 64) : null,
    };
    this.queue.push(ev);
    this.emit(projectId, { kind: ev.kind, path: ev.path, status: ev.status, ms: ev.ms, ref: ev.ref, device: ev.device, name: ev.name, ts: ev.ts, browser: browserOf(ua) });
    if (this.queue.length > 500) this.flush();
  }

  flush() {
    if (!this.queue.length) return;
    const batch = this.queue.splice(0);
    tx(this.db, () => {
      for (const e of batch) this.insert.run(e.projectId, e.ts, e.kind, e.path, e.status, e.ms, e.bytes, e.ref, e.device, e.visitor, e.name);
    });
  }

  prune() {
    this.flush();
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(Date.now() - RETENTION);
  }

  deleteProject(projectId) {
    this.flush();
    this.db.prepare('DELETE FROM events WHERE project_id = ?').run(projectId);
  }

  live(projectId) {
    this.flush();
    const since = Date.now() - 5 * 60e3;
    return this.db.prepare("SELECT COUNT(DISTINCT visitor) AS n FROM events WHERE project_id = ? AND ts >= ? AND kind IN ('page','event') AND device != 'bot'").get(projectId, since).n;
  }

  summary(projectId, range = '24h') {
    this.flush();
    const [span, bucket] = RANGES[range] || RANGES['24h'];
    const now = Date.now();
    const since = now - span;
    const q = (sql, ...args) => this.db.prepare(sql).all(projectId, since, ...args);
    const one = (sql) => this.db.prepare(sql).get(projectId, since);
    const totals = one(`SELECT
        SUM(kind = 'page') AS views,
        COUNT(DISTINCT CASE WHEN kind = 'page' AND device != 'bot' THEN visitor END) AS visitors,
        COUNT(*) AS requests,
        SUM(kind = 'fn') AS fnCalls,
        SUM(kind = 'db') AS dbCalls,
        SUM(kind = 'event') AS events,
        SUM(status >= 400) AS errors,
        AVG(CASE WHEN kind IN ('page', 'fn') THEN ms END) AS avgMs,
        COALESCE(SUM(bytes), 0) AS bandwidth
      FROM events WHERE project_id = ? AND ts >= ?`);
    const start = Math.floor(since / bucket) * bucket;
    const rows = q(`SELECT (ts / ${bucket}) * ${bucket} AS t, SUM(kind = 'page') AS views, COUNT(DISTINCT CASE WHEN kind = 'page' AND device != 'bot' THEN visitor END) AS visitors, SUM(kind = 'fn') AS fn, SUM(status >= 400) AS errors
      FROM events WHERE project_id = ? AND ts >= ? GROUP BY t ORDER BY t`);
    const byT = new Map(rows.map((r) => [r.t, r]));
    const series = [];
    for (let t = start; t <= now; t += bucket) {
      const r = byT.get(t);
      series.push({ t, views: r ? r.views : 0, visitors: r ? r.visitors : 0, fn: r ? r.fn : 0, errors: r ? r.errors : 0 });
    }
    const top = (col, where = '1') => q(`SELECT ${col} AS key, COUNT(*) AS n FROM events WHERE project_id = ? AND ts >= ? AND ${col} IS NOT NULL AND ${where} GROUP BY ${col} ORDER BY n DESC LIMIT 10`);
    return {
      range,
      bucketMs: bucket,
      totals: { ...totals, views: totals.views || 0, fnCalls: totals.fnCalls || 0, dbCalls: totals.dbCalls || 0, events: totals.events || 0, errors: totals.errors || 0, avgMs: totals.avgMs ? Math.round(totals.avgMs * 10) / 10 : 0 },
      live: this.live(projectId),
      series,
      pages: top('path', "kind = 'page'"),
      referrers: top('ref', "kind = 'page'"),
      devices: top('device', "kind = 'page'"),
      statuses: top('status'),
      functions: top('name', "kind = 'fn'"),
      events: top('name', "kind = 'event'"),
    };
  }

  close() {
    clearInterval(this.flushTimer);
    clearInterval(this.pruneTimer);
    this.flush();
  }
}

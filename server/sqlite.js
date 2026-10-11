// SQLite storage (node:sqlite, built into Node 22.5+) for high-volume data:
// analytics events, project databases and saved models.
import path from 'node:path';

// node:sqlite prints an ExperimentalWarning on load; keep logs clean.
const origEmit = process.emitWarning;
process.emitWarning = function emitWarning(warning, ...rest) {
  const text = typeof warning === 'string' ? warning : warning?.message;
  if (text && text.includes('SQLite is an experimental feature')) return;
  return origEmit.call(process, warning, ...rest);
};
const { DatabaseSync } = await import('node:sqlite');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,          -- page | asset | fn | db | event
  path TEXT,
  status INTEGER,
  ms REAL,
  bytes INTEGER,
  ref TEXT,
  device TEXT,
  visitor TEXT,
  name TEXT
);
CREATE INDEX IF NOT EXISTS events_project_ts ON events(project_id, ts);
CREATE TABLE IF NOT EXISTS salts (day TEXT PRIMARY KEY, salt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS collections (
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  read_rule TEXT NOT NULL DEFAULT 'private',
  write_rule TEXT NOT NULL DEFAULT 'private',
  created INTEGER NOT NULL,
  PRIMARY KEY (project_id, name)
);
CREATE TABLE IF NOT EXISTS docs (
  project_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (project_id, collection, id)
);
CREATE INDEX IF NOT EXISTS docs_created ON docs(project_id, collection, created);
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  family TEXT NOT NULL,
  params TEXT NOT NULL,
  source TEXT,
  public INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS models_user ON models(user_id, updated);
CREATE INDEX IF NOT EXISTS models_public ON models(public, updated);
`;

export function openDatabase(dataDir) {
  const db = new DatabaseSync(dataDir ? path.join(dataDir, 'chroma.sqlite') : ':memory:');
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside a transaction. */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

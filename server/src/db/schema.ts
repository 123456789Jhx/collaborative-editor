import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * SQLite through Node's built-in driver, so the server gains persistence with
 * zero new runtime dependencies and no native build step in the alpine image.
 *
 * The single-writer property is a feature here, not a compromise: `compose.yaml`
 * already pins the server to one replica because the document lives in memory,
 * so the database is under exactly the same constraint. Nothing new to reconcile.
 */

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- COLLATE NOCASE so "Root" and "root" cannot both exist; without it the
  -- uniqueness that the login lookup relies on would be case-sensitive.
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  salt          TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user'   CHECK (role IN ('admin','user')),
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','readonly','deleted')),
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  -- SET NULL rather than CASCADE: deleting a user must not erase what they did.
  user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Deliberate denormalization for the same reason: the log stays readable
  -- after the row it points at is gone.
  username_snapshot TEXT    NOT NULL,
  at                INTEGER NOT NULL,
  version           INTEGER NOT NULL,
  op_count          INTEGER NOT NULL,
  ops_json          TEXT    NOT NULL,
  summary           TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_at      ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_audit_user_at ON audit_log(user_id, at);
`;

/**
 * Idempotent by `IF NOT EXISTS`. A real deployment would need a `user_version`
 * migration ladder; for this schema, adding a table or an index is a no-op on
 * an existing file, and changing a column is not supported — the file would
 * have to be recreated.
 */
export function migrate(db: Db): void {
  db.exec(SCHEMA);
}

export function openDatabase(path: string): Db {
  // The caller passes a path, not a directory, so creating the parent is this
  // function's job — otherwise the first run against a fresh volume fails with
  // SQLITE_CANTOPEN instead of just working.
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  // SQLite does not enforce foreign keys unless asked, per connection.
  db.exec("PRAGMA foreign_keys = ON");
  // WAL lets a read proceed during a write. Irrelevant for :memory:, where
  // SQLite reports "memory" and ignores the request.
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

import type { DatabaseSync } from 'node:sqlite';
import { chmodSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { updateIdentity } from './inbox-identity.ts';

export const SCHEMA_VERSION = 5;

/** Keep the original schema recoverable; schema and data changes commit together. */
export function migrateStorage(db: DatabaseSync, data: string, version: number): void {
  if (version < SCHEMA_VERSION && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get()) {
    const target = join(data, `before-migration-v${version}-${Date.now()}-${randomUUID().slice(0, 8)}.sqlite`);
    const temporary = target + '.partial';
    try { db.prepare('VACUUM INTO ?').run(temporary); chmodSync(temporary, 0o600); renameSync(temporary, target); }
    finally { rmSync(temporary, { force: true }); }
  }
  const get = (key: string) => (db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {value: string} | undefined)?.value;
  const set = (key: string, value: string) => db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, provider TEXT NOT NULL, native_id TEXT, name TEXT NOT NULL,
        mode TEXT NOT NULL, applied TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(update_id INTEGER PRIMARY KEY, payload TEXT NOT NULL, handled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), update_id INTEGER UNIQUE NOT NULL,
        text TEXT, voice TEXT, state TEXT NOT NULL, result TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), type TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), kind TEXT NOT NULL,
        body TEXT NOT NULL, message_id INTEGER, state TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY, text TEXT NOT NULL, buttons TEXT, request_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state, created);
      CREATE TABLE IF NOT EXISTS message_sessions(message_id INTEGER PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id));
    `);
    // Column checks also tolerate an interrupted/test migration without dropping data.
    const outboxColumns = db.prepare('PRAGMA table_info(outbox)').all().map(row => row.name);
    if (!outboxColumns.includes('edit_message_id')) db.exec('ALTER TABLE outbox ADD COLUMN edit_message_id INTEGER');
    if (!outboxColumns.includes('reply_to_message_id')) db.exec('ALTER TABLE outbox ADD COLUMN reply_to_message_id INTEGER');
    const jobColumns = db.prepare('PRAGMA table_info(jobs)').all().map(row => row.name);
    if (!jobColumns.includes('origin_message_id')) db.exec('ALTER TABLE jobs ADD COLUMN origin_message_id INTEGER');
    if (version < 4) {
      for (const row of db.prepare('SELECT jobs.id,jobs.session_id,inbox.payload FROM jobs JOIN inbox ON inbox.update_id=jobs.update_id WHERE jobs.origin_message_id IS NULL').all()) {
        let messageId: unknown;
        try { messageId = JSON.parse(String(row.payload)).message?.message_id; } catch { continue; }
        if (typeof messageId === 'number' && Number.isSafeInteger(messageId) && messageId > 0) {
          db.prepare('UPDATE jobs SET origin_message_id=? WHERE id=?').run(messageId, row.id);
          db.prepare('INSERT OR IGNORE INTO message_sessions VALUES (?,?)').run(messageId, row.session_id);
        }
      }
    }
    if (version < 3 && get('paused') === 'true') {
      for (const session of db.prepare("SELECT DISTINCT session_id FROM jobs WHERE state IN ('queued','preparing','running','waiting_input','unknown')").all()) set(`paused:${session.session_id}`, 'true');
      set('paused', 'false');
    }

    const addColumn = (table: string, column: string, definition: string) => {
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    addColumn('outbox', 'failed_at', 'INTEGER');
    addColumn('outbox', 'last_error', 'TEXT');
    addColumn('outbox', 'failure_count', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('outbox', 'created', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('inbox', 'received_at', 'INTEGER NOT NULL DEFAULT 0');
    db.exec(`
      CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(update_id) WHERE handled=0;
      CREATE INDEX IF NOT EXISTS inbox_retention ON inbox(received_at) WHERE handled=1 AND payload<>'{}';
      CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(id) WHERE sent=0 AND failed_at IS NULL;
      CREATE INDEX IF NOT EXISTS outbox_retention ON outbox(created) WHERE sent=1;
      CREATE INDEX IF NOT EXISTS requests_message ON requests(message_id);
      CREATE INDEX IF NOT EXISTS jobs_origin ON jobs(origin_message_id);
      CREATE INDEX IF NOT EXISTS jobs_session_state ON jobs(session_id,state,created);
      CREATE TABLE IF NOT EXISTS telegram_receipts(epoch INTEGER NOT NULL,update_id INTEGER NOT NULL,local_id INTEGER NOT NULL,PRIMARY KEY(epoch,update_id));
      CREATE TABLE IF NOT EXISTS telegram_seen(identity TEXT PRIMARY KEY,local_id INTEGER NOT NULL);
    `);
    if (version < SCHEMA_VERSION) {
      db.prepare('UPDATE outbox SET created=? WHERE created=0').run(Date.now());
      db.prepare('UPDATE inbox SET received_at=? WHERE received_at=0').run(Date.now());
      const remember = db.prepare('INSERT OR IGNORE INTO telegram_seen VALUES (?,?)');
      for (const row of db.prepare("SELECT update_id,payload FROM inbox WHERE payload<>'{}'").iterate()) {
        try { const identity = updateIdentity(JSON.parse(String(row.payload))); if (identity) remember.run(identity, row.update_id); }
        catch { /* A corrupt historic payload must not prevent access to preserved jobs. */ }
      }
    }
    if (!get('last_update_at')) {
      if (get('offset')) set('legacy_offset_probe', 'true');
      set('last_update_at', String(Date.now()));
    }
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; COMMIT`);
  } catch (error) { try { db.exec('ROLLBACK'); } catch { /* preserve original failure */ } throw error; }
}

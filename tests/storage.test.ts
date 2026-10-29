import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/storage.ts';
import { backupState } from '../src/storage.ts';
import { DatabaseSync } from 'node:sqlite';
import { acquireLock } from '../src/service.ts';
import { fixture, message } from './helpers.ts';

test('durable inbox: duplicate update produces one row and persistent offset', async () => {
  const f = fixture();
  try {
    f.store.ingest([message(10, 'hello'), message(10, 'hello')], () => true);
    assert.equal(f.store.get('offset'), '11');
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM inbox').get()!.n, 1);
    f.store.ingest([message(20, 'unauthorized', 999)], () => false);
    assert.equal(f.store.get('offset'), '21'); assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM inbox').get()!.n, 1);
    const second = new Store(f.config); assert.equal(second.get('offset'), '21'); second.close();
  } finally { await f.close(); }
});
test('transaction rollback does not lose an accepted update', async () => {
  const f = fixture(); try {
    f.store.ingest([message(1, 'x')], () => true);
    assert.throws(() => f.store.tx(() => { f.store.handled(1); f.store.createSession('codex', 'full'); throw new Error('crash'); }));
    assert.equal(f.store.pendingInput()?.update_id, 1); assert.equal(f.store.sessions().length, 0);
  } finally { await f.close(); }
});
test('restart pauses uncertain runs, expires requests and preserves queued work', async () => {
  const f = fixture(); try {
    const s = f.store.createSession('codex', 'full');
    const running = f.store.enqueue(1, s, 'running', null), queued = f.store.enqueue(2, s, 'queued', null);
    f.store.state(running.id, 'running');
    f.store.db.prepare("INSERT INTO requests VALUES ('req',?,'permission','approve',1,'pending',?)").run(running.id, Date.now());
    assert.equal(f.store.recover(), 1); assert.equal(f.store.paused, true);
    assert.equal(f.store.job(running.id)?.state, 'unknown'); assert.equal(f.store.job(queued.id)?.state, 'queued');
    assert.equal(f.store.request('req')?.state, 'expired'); assert.equal(f.store.recover(), 0);
  } finally { await f.close(); }
});
test('moved project state is rejected, future schema is rejected', async () => {
  const f = fixture(); try {
    assert.throws(() => new Store({ ...f.config, project: '/different' }), /другому пути/);
    f.store.db.exec('PRAGMA user_version=99');
    assert.throws(() => new Store(f.config), /более новой/);
  } finally { await f.close(); }
});
test('SQLite process lock refuses duplicate owner and can be reacquired', async () => {
  const f = fixture(); try {
    const file = join(f.config.data, 'lock.sqlite'); const release = acquireLock(file);
    assert.throws(() => acquireLock(file), /Другой экземпляр/); release(); acquireLock(file)();
  } finally { await f.close(); }
});
test('moved project is refused before migration mutates its schema or pause state', async () => {
  const f = fixture(); try {
    f.store.db.exec('PRAGMA user_version=2'); f.store.set('paused', 'true');
    assert.throws(() => new Store({ ...f.config, project: '/other-project' }), /другому пути/);
    assert.equal(f.store.db.prepare('PRAGMA user_version').get()!.user_version, 2); assert.equal(f.store.get('paused'), 'true');
  } finally { await f.close(); }
});
test('online backup copies an old schema without migrating the live database', async () => {
  const f = fixture(); try {
    f.store.createSession('codex', 'full'); f.store.db.exec('PRAGMA user_version=2');
    const path = await backupState(f.config.data);
    assert.equal(f.store.db.prepare('PRAGMA user_version').get()!.user_version, 2);
    const saved = new DatabaseSync(path, { readOnly: true });
    try { assert.equal(saved.prepare('PRAGMA user_version').get()!.user_version, 2); assert.equal(saved.prepare('SELECT count(*) AS n FROM sessions').get()!.n, 1); }
    finally { saved.close(); }
  } finally { await f.close(); }
});
test('schema migration recovers originating prompt IDs from durable inbox history', async () => {
  const f = fixture(); try {
    const s = f.store.createSession('codex', 'full'); f.store.ingest([message(44, 'old prompt')], () => true);
    const job = f.store.enqueue(44, s, 'old prompt', null);
    f.store.db.exec('PRAGMA user_version=2');
    const upgraded = new Store(f.config);
    try { assert.equal(upgraded.job(job.id)?.origin_message_id, 44); assert.equal(upgraded.sessionForMessage(44), s.id); }
    finally { upgraded.close(); }
  } finally { await f.close(); }
});
test('legacy shutdown pause is migrated to pending sessions without freezing idle sessions', async () => {
  const f = fixture(); try {
    const idle = f.store.createSession('codex', 'full'), pending = f.store.createSession('claude', 'full');
    f.store.enqueue(1, pending, 'pending', null); f.store.set('paused', 'true'); f.store.db.exec('PRAGMA user_version=2');
    const upgraded = new Store(f.config);
    try { assert.equal(upgraded.pausedFor(pending.id), true); assert.equal(upgraded.pausedFor(idle.id), false); assert.equal(upgraded.get('paused'), 'false'); }
    finally { upgraded.close(); }
  } finally { await f.close(); }
});

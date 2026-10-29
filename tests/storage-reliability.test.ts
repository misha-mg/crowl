import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, message, callback, route } from './helpers.ts';
import { Store, IDLE_OFFSET_RESET_MS } from '../src/storage.ts';
import { SCHEMA_VERSION } from '../src/migrations.ts';
import { loadConfig } from '../src/config.ts';

const DAY = 86_400_000;

test('upgrade preserves an original snapshot and adds indexed pending queries', async () => {
  const f = fixture(); try {
    f.store.set('sentinel', 'preserve me');
    f.store.db.exec('PRAGMA user_version=4');
    const upgraded = new Store(f.config);
    try {
      assert.equal(upgraded.db.prepare('PRAGMA user_version').get()!.user_version, SCHEMA_VERSION);
      assert.equal(upgraded.get('sentinel'), 'preserve me');
      for (const [sql, index] of [
        ["SELECT update_id,payload FROM inbox WHERE handled=0 ORDER BY update_id LIMIT 1", 'inbox_pending'],
        ["SELECT * FROM outbox WHERE sent=0 AND failed_at IS NULL ORDER BY id LIMIT 1", 'outbox_pending'],
      ]) assert.match(JSON.stringify(upgraded.db.prepare('EXPLAIN QUERY PLAN ' + sql).all()), new RegExp(index));
      const snapshot = readdirSync(f.config.data).find(name => name.startsWith('before-migration-v4-'));
      assert.ok(snapshot);
      const saved = new DatabaseSync(join(f.config.data, snapshot), { readOnly: true });
      try {
        assert.equal(saved.prepare('PRAGMA user_version').get()!.user_version, 4);
        assert.equal(saved.prepare("SELECT value FROM meta WHERE key='sentinel'").get()!.value, 'preserve me');
      } finally { saved.close(); }
    } finally { upgraded.close(); }
  } finally { await f.close(); }
});

test('failed migration rolls back pause conversion and leaves database usable', async () => {
  const f = fixture(); try {
    const s = f.store.createSession('codex', 'full'); f.store.enqueue(1, s, 'pending', null);
    f.store.set('paused', 'true');
    f.store.db.exec("PRAGMA user_version=2; CREATE TRIGGER reject_pause BEFORE UPDATE ON meta WHEN NEW.key='paused' BEGIN SELECT RAISE(ABORT,'test migration failure'); END;");
    assert.throws(() => new Store(f.config), /test migration failure/);
    assert.equal(f.store.db.prepare('PRAGMA user_version').get()!.user_version, 2);
    assert.equal(f.store.get('paused'), 'true');
    assert.equal(f.store.get(`paused:${s.id}`), undefined);
    f.store.db.exec('DROP TRIGGER reject_pause');
    const retry = new Store(f.config);
    try { assert.equal(retry.pausedFor(s.id), true); } finally { retry.close(); }
  } finally { await f.close(); }
});

test('technical retention preserves results, pending delivery and duplicate protection', async () => {
  const f = fixture(); try {
    f.store.set('chat', '123'); f.store.createSession('codex', 'full');
    route(f, message(1, 'task')); f.engine.kick(); await f.engine.settle();
    const output = f.store.pendingOutput()!; f.store.markOutputSent(output.id);
    f.store.outgoing('pending'); f.store.outgoing('failed');
    const failed = f.store.db.prepare("SELECT id FROM outbox WHERE text='failed'").get()!;
    f.store.failOutput(Number(failed.id), 'permanent', 1000);
    f.store.db.exec('UPDATE inbox SET received_at=1000; UPDATE outbox SET created=1000');
    const result = f.store.pruneTechnicalHistory(40 * DAY);
    assert.deepEqual(result, { inbox: 1, outbox: 1 });
    assert.equal(f.store.db.prepare('SELECT payload FROM inbox').get()!.payload, '{}');
    assert.equal(f.store.db.prepare("SELECT result FROM jobs WHERE state='completed'").get()!.result, 'Результат');
    assert.equal(f.store.pendingOutput()!.text, 'pending'); assert.equal(f.store.failedOutputCount(), 1);
    route(f, message(1, 'task')); f.engine.kick(); await f.engine.settle();
    assert.equal(f.prompts.length, 1);
  } finally { await f.close(); }
});

test('week idle permits lower Telegram IDs without replaying or colliding with old jobs', async () => {
  const f = fixture(); try {
    f.store.set('chat', '123'); f.store.createSession('codex', 'full');
    f.store.ingest([message(50, 'old')], () => true, 1000); f.engine.drainInbox(); f.engine.kick(); await f.engine.settle();
    assert.equal(f.store.pollingOffset(1001), 51);
    const now = 1001 + 7 * DAY;
    assert.equal(f.store.pollingOffset(now), 0);
    // The exact same raw update ID can be reused in a new Telegram generation.
    const next = message(50, 'new'); next.message!.message_id = 51;
    f.store.ingest([next, next], () => true, now); f.engine.drainInbox(); f.engine.kick(); await f.engine.settle();
    assert.deepEqual(f.prompts.map(p => p.prompt), ['old', 'new']);
    assert.equal(f.store.get('offset'), '51');
    const reopened = new Store(f.config);
    try {
      reopened.ingest([next, message(2, 'lower')], () => true, now + 1);
      assert.equal(reopened.db.prepare('SELECT count(*) n FROM inbox').get()!.n, 3);
    } finally { reopened.close(); }
  } finally { await f.close(); }
});

test('poll failures and empty responses do not hide an idle offset reset', async () => {
  const f = fixture(); try {
    f.store.ingest([message(100, 'x')], () => false, 1000);
    f.store.ingest([], () => true, 1000 + 8 * DAY);
    assert.equal(f.store.pollingOffset(1000 + 8 * DAY), 0);
    f.store.ingest([message(2, 'fresh')], () => true, 1000 + 8 * DAY);
    assert.equal(f.store.pollingOffset(1001 + 8 * DAY), 3);
  } finally { await f.close(); }
});

test('legacy offset probes immediately and deduplicates retained messages and callbacks across batches', async () => {
  const f = fixture(); try {
    const old = [message(10, 'old'), callback(11, 'old-button')];
    f.store.ingest(old, () => true); for (const update of old) f.store.handled(update.update_id);
    f.store.db.exec("DROP TABLE telegram_seen; DELETE FROM meta WHERE key='last_update_at'; PRAGMA user_version=4");
    const upgraded = new Store(f.config);
    try {
      assert.equal(upgraded.pollingOffset(), 0);
      upgraded.ingest([old[0]], () => true); upgraded.ingest([old[1]], () => true);
      assert.equal(upgraded.pendingInput(), undefined);
      assert.equal(upgraded.db.prepare('SELECT count(*) n FROM inbox').get()!.n, 2);
      const freshCallback = callback(12, 'new-button');
      upgraded.ingest([freshCallback], () => true);
      assert.ok(upgraded.pendingInput()); // callbacks share the source message, but have distinct callback IDs
    } finally { upgraded.close(); }
  } finally { await f.close(); }
});

test('legacy random-ID collision remains a new message, not an old command replay', async () => {
  const f = fixture(); try {
    f.store.ingest([message(100, 'old')], () => true); f.store.handled(100);
    f.store.db.exec("DROP TABLE telegram_seen; DELETE FROM meta WHERE key='last_update_at'; PRAGMA user_version=4");
    const upgraded = new Store(f.config);
    try {
      const fresh = message(100, 'fresh'); fresh.message!.message_id = 200;
      upgraded.ingest([fresh], () => true);
      const next = upgraded.pendingInput()!;
      assert.notEqual(next.update_id, 100);
      assert.equal(JSON.parse(next.payload).message.text, 'fresh');
      upgraded.handled(next.update_id);
      upgraded.ingest([fresh], () => true); assert.equal(upgraded.pendingInput(), undefined);
    } finally { upgraded.close(); }
  } finally { await f.close(); }
});

test('idle probing starts before the seven-day boundary and survives payload pruning', async () => {
  const f = fixture(); try {
    const original = message(9, 'one');
    f.store.ingest([original], () => true, 1000); f.store.handled(9);
    assert.equal(f.store.pollingOffset(1000 + IDLE_OFFSET_RESET_MS - 1), 10);
    assert.equal(f.store.pollingOffset(1000 + IDLE_OFFSET_RESET_MS), 0);
    f.store.pruneTechnicalHistory(40 * DAY);
    f.store.ingest([original], () => true, 40 * DAY);
    assert.equal(f.store.pendingInput(), undefined);
  } finally { await f.close(); }
});

test('terminal tasks cannot accidentally return to running and results survive invalid transitions', async () => {
  const f = fixture(); try {
    const s = f.store.createSession('codex', 'full'), job = f.store.enqueue(1, s, 'task', null);
    assert.throws(() => f.store.state(job.id, 'completed'), /Недопустимый переход/);
    f.store.state(job.id, 'running'); f.store.state(job.id, 'completed', 'done');
    assert.throws(() => f.store.state(job.id, 'running'), /Недопустимый переход/);
    assert.equal(f.store.job(job.id)!.result, 'done');
  } finally { await f.close(); }
});

test('default project configuration serializes runs; explicit concurrency remains configurable', async () => {
  const f = fixture(); try {
    writeFileSync(join(f.config.root, '.env'), 'MAX_CONCURRENT_SESSIONS=\n');
    assert.equal(loadConfig(f.config.root, false).maxConcurrentSessions, 1);
    writeFileSync(join(f.config.root, '.env'), 'MAX_CONCURRENT_SESSIONS=4\n');
    assert.equal(loadConfig(f.config.root, false).maxConcurrentSessions, 4);
  } finally { await f.close(); }
});

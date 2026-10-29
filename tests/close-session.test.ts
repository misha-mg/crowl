import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, route, message, callback, until } from './helpers.ts';

test('close detaches the session, preserves native history, and shows a fresh provider chooser', async () => {
  const f = fixture(); try {
    f.store.set('chat', '123'); const old = f.store.createSession('codex', 'full');
    f.store.db.prepare('UPDATE sessions SET native_id=? WHERE id=?').run('saved-native', old.id);
    route(f, message(1, '/close'));
    assert.equal(f.store.session(), undefined); assert.equal(f.store.session(old.id)?.native_id, 'saved-native');
    const menu = f.store.pendingOutput()!;
    assert.deepEqual(JSON.parse(menu.buttons!).inline_keyboard.flat().map((b: any) => b.text).sort(), ['Claude', 'Codex']);
    const nonce = f.store.get('chooser'); route(f, callback(2, `new:claude:${nonce}`));
    assert.equal(f.store.session()?.provider, 'claude'); assert.notEqual(f.store.session()?.id, old.id);
    assert.equal(f.store.session()?.native_id, null); assert.equal(f.store.paused, false);
    route(f, message(3, 'new task')); f.engine.kick(); await f.engine.settle(); assert.equal(f.prompts.length, 1);
  } finally { await f.close(); }
});
test('close cancels queued work instead of transferring it to the next agent', async () => {
  const f = fixture(); try {
    f.store.set('chat', '123'); const old = f.store.createSession('codex', 'full');
    route(f, message(1, 'old task')); const job = f.store.next()!;
    route(f, message(2, '/close')); f.engine.kick();
    assert.equal(f.store.job(job.id)?.state, 'interrupted'); assert.equal(f.store.queue().length, 0); assert.equal(f.prompts.length, 0);
    assert.ok(f.store.session(old.id)); assert.ok(f.store.get('chooser'));
  } finally { await f.close(); }
});
test('close interrupts an active approval, expires buttons, then allows a new agent immediately', async () => {
  const f = fixture(() => ({ provider: 'codex', async run(options) { await options.callbacks.input({ kind: 'permission', title: 'Wait' }); return 'not reached'; }, async close() {} }));
  try {
    f.store.set('chat', '123'); f.store.createSession('codex', 'ask');
    route(f, message(1, 'active')); f.engine.kick();
    await until(() => !!f.store.db.prepare("SELECT 1 FROM requests WHERE state='pending'").get());
    const request = String(f.store.db.prepare('SELECT id FROM requests').get()!.id);
    route(f, message(2, 'queued')); route(f, message(3, '/close'));
    route(f, message(4, '/close')); // repeated close does not spawn a second shutdown
    await f.engine.settle();
    assert.equal(f.store.session(), undefined); assert.equal(f.store.paused, false); assert.equal(f.engine.active, false);
    assert.equal(f.store.request(request)?.state, 'expired'); assert.equal(f.store.queue().length, 0);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM jobs WHERE state='interrupted'").get()!.n, 2);
    assert.ok(f.store.get('chooser')); assert.equal(f.engine.fatal, undefined);
    route(f, callback(5, `new:claude:${f.store.get('chooser')}`)); assert.equal(f.store.session()?.provider, 'claude');
    route(f, callback(6, `reply:${request}:yes`)); assert.equal(f.store.request(request)?.state, 'expired');
  } finally { await f.close(); }
});
test('close before a session is selected is safe, and other users cannot close it', async () => {
  const f = fixture(); try {
    f.store.set('chat', '123'); route(f, message(1, '/close')); assert.ok(f.store.get('chooser'));
    const old = f.store.createSession('claude', 'full'); route(f, message(2, '/close', 999)); assert.equal(f.store.session()?.id, old.id);
    route(f, message(3, '/close')); route(f, callback(4, `session:${old.id}`)); assert.equal(f.store.session()?.id, old.id);
  } finally { await f.close(); }
});
test('close invalidates the previous chooser and clears a paused empty queue', async () => {
  const f = fixture(); try {
    f.store.set('chat', '123'); f.store.createSession('codex', 'full');
    route(f, message(1, '/new')); const oldMenu = f.store.get('chooser');
    f.store.paused = true; route(f, message(2, '/close'));
    route(f, callback(3, `new:codex:${oldMenu}`)); assert.equal(f.store.session(), undefined);
    route(f, callback(4, `new:codex:${f.store.get('chooser')}`)); assert.ok(f.store.session()); assert.equal(f.store.paused, false);
  } finally { await f.close(); }
});

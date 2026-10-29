import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, message, callback, route, until } from './helpers.ts';
import { flushOne } from '../src/runtime.ts';
import { Uncertain } from '../src/providers/types.ts';

test('owner only; stale chooser cannot create extra sessions', async () => {
  const f = fixture(); try {
    route(f, message(1, '/start', 999)); assert.equal(f.store.get('chat'), undefined);
    route(f, message(2, '/start')); const nonce = f.store.get('chooser');
    route(f, callback(3, `new:codex:${nonce}`, 999)); assert.equal(f.store.sessions().length, 0);
    route(f, callback(4, `new:codex:${nonce}`)); assert.equal(f.store.sessions().length, 1);
    route(f, callback(5, `new:codex:${nonce}`)); assert.equal(f.store.sessions().length, 1);
  } finally { await f.close(); }
});
test('two prompts use exact same native session, duplicates do not rerun', async () => {
  const f = fixture(); try {
    f.store.set('chat', '123'); f.store.createSession('codex', 'full');
    route(f, message(1, 'Первая задача')); route(f, message(1, 'Первая задача'));
    f.engine.kick(); await f.engine.settle(); route(f, message(2, 'Продолжи')); f.engine.kick(); await f.engine.settle();
    assert.equal(f.prompts.length, 2); assert.equal(f.prompts[0].nativeId, null); assert.equal(f.prompts[1].nativeId, 'native-1'); assert.equal(f.prompts[0].cwd, f.config.project);
  } finally { await f.close(); }
});
test('clear preserves old session, rename and permissions are per session', async () => {
  const f = fixture(); try {
    f.store.set('chat', '123'); const original = f.store.createSession('claude', 'full');
    route(f, message(1, '/rename Авторизация')); assert.equal(f.store.session()?.name, 'Авторизация');
    route(f, callback(2, `mode:${original.id}:ask`)); assert.equal(f.store.session()?.mode, 'ask'); assert.equal(f.store.session()?.applied, null);
    route(f, message(3, '/clear')); const next = f.store.session()!;
    assert.notEqual(next.id, original.id); assert.equal(next.mode, 'ask'); assert.equal(next.provider, 'claude');
    assert.equal(f.store.session(original.id)?.name, 'Авторизация');
    route(f, callback(4, `mode:${original.id}:full`)); assert.equal(f.store.session()?.mode, 'ask');
  } finally { await f.close(); }
});
test('queued job session cannot be changed, stop pauses until explicit resume', async () => {
  const f = fixture(); try {
    f.store.set('chat', '123'); const original = f.store.createSession('codex', 'full');
    route(f, message(1, 'task')); route(f, message(2, '/new')); assert.equal(f.store.queue()[0].session_id, original.id);
    route(f, message(3, '/stop')); f.engine.kick(); assert.equal(f.engine.active, false);
    route(f, message(4, 'second')); assert.equal(f.store.queue().length, 2); f.engine.kick(); assert.equal(f.engine.active, false);
    route(f, message(5, '/queue')); route(f, callback(6, `queue:resume:${f.store.get('queue_menu')}`));
    f.engine.kick(); await f.engine.settle(); assert.equal(f.prompts.length, 1);
  } finally { await f.close(); }
});
test('voice reserves FIFO position, failed STT does not execute an empty prompt', async () => {
  const f = fixture(); try {
    f.store.set('chat', '123'); f.store.createSession('codex', 'full');
    route(f, { update_id: 1, message: { ...message(1, '').message!, text: undefined, voice: { file_id: 'voice', duration: 2 } } });
    route(f, message(2, 'After voice'));
    const first = f.store.next()!; assert.ok(first.voice);
    f.engine.kick(); await f.engine.settle(); assert.equal(f.store.job(first.id)?.state, 'failed'); assert.equal(f.prompts.length, 0);
    f.engine.kick(); await f.engine.settle(); assert.equal(f.prompts[0].prompt, 'After voice'); assert.equal(f.messenger.downloads, 0);
  } finally { await f.close(); }
});
test('permission callbacks are owner-bound, stale replies rejected, stop remains available', async () => {
  const f = fixture(() => ({ provider: 'codex', async run(options) { const reply = await options.callbacks.input({ kind: 'permission', title: 'Edit file?' }); return reply.allow ? 'Allowed' : 'Denied'; }, async close() {} }));
  try {
    f.store.set('chat', '123'); f.store.createSession('codex', 'ask'); route(f, message(1, 'task')); f.engine.kick();
    await until(() => !!f.store.db.prepare("SELECT 1 FROM requests WHERE state='pending'").get());
    const request = f.store.db.prepare('SELECT id FROM requests').get()!;
    route(f, callback(2, `reply:${request.id}:yes`, 999)); assert.equal(f.store.request(String(request.id))?.state, 'pending');
    route(f, callback(3, `reply:${request.id}:yes`)); await f.engine.settle();
    assert.equal(f.store.request(String(request.id))?.state, 'answered');
    route(f, callback(4, `reply:${request.id}:no`));
    assert.equal(f.store.db.prepare("SELECT result FROM jobs WHERE state='completed'").get()!.result, 'Allowed');
  } finally { await f.close(); }
});
test('free text is queued, Reply answers the specific pending question', async () => {
  const f = fixture(() => ({ provider: 'claude', async run(options) { const reply = await options.callbacks.input({ kind: 'question', title: 'Choose', questions: [{ id: 'q', text: 'Which?' }] }); return reply.answers!.q; }, async close() {} }));
  try {
    f.store.set('chat', '123'); f.store.createSession('claude', 'full'); route(f, message(1, 'task')); f.engine.kick();
    await until(() => !!f.store.db.prepare("SELECT 1 FROM requests WHERE state='pending'").get());
    while (await flushOne(f.store, f.messenger, 123)) { /* deliver request */ }
    const request = f.store.db.prepare('SELECT * FROM requests').get()!;
    route(f, message(2, 'ordinary prompt')); assert.equal(f.store.queue().length, 1);
    route(f, message(3, 'answer', 123, Number(request.message_id))); await f.engine.settle();
    assert.equal(f.store.db.prepare("SELECT result FROM jobs WHERE state='completed'").get()!.result, 'answer');
  } finally { await f.close(); }
});
test('stop cancels a pending question, queued work stays paused', async () => {
  const f = fixture(() => ({ provider: 'codex', async run(options) { await options.callbacks.input({ kind: 'permission', title: 'Waiting' }); return 'bad'; }, async close() {} }));
  try {
    f.store.set('chat', '123'); f.store.createSession('codex', 'ask'); route(f, message(1, 'task')); f.engine.kick();
    await until(() => !!f.store.db.prepare("SELECT 1 FROM requests WHERE state='pending'").get());
    route(f, message(2, '/stop')); await f.engine.settle();
    assert.equal(f.store.paused, true); assert.equal(f.store.db.prepare('SELECT state FROM jobs').get()!.state, 'interrupted');
    assert.equal(f.store.db.prepare('SELECT state FROM requests').get()!.state, 'expired');
  } finally { await f.close(); }
});
test('uncertain provider disconnect pauses queue instead of retrying', async () => {
  const f = fixture(() => ({ provider: 'codex', async run() { throw new Uncertain(); }, async close() {} }));
  try { f.store.set('chat', '123'); f.store.createSession('codex', 'full'); route(f, message(1, 'task')); route(f, message(2, 'next')); f.engine.kick(); await f.engine.settle(); assert.equal(f.store.paused, true); assert.equal(f.store.queue().length, 1); assert.equal(f.store.db.prepare("SELECT count(*) n FROM jobs WHERE state='unknown'").get()!.n, 1); }
  finally { await f.close(); }
});
test('queue overflow is visible; unknown commands never become prompts', async () => {
  const f = fixture(); try {
    f.store.set('chat', '123'); f.store.createSession('codex', 'full');
    route(f, message(1, '/unknown'));
    for (let i = 2; i < 23; i++) route(f, message(i, 'task'));
    assert.equal(f.store.queue().length, 20);
    assert.match(String(f.store.db.prepare('SELECT text FROM outbox ORDER BY id DESC LIMIT 1').get()!.text), /заполнена/);
  } finally { await f.close(); }
});
test('provider cancellation expires its request and stale approval cannot execute it', async () => {
  const cancel = new AbortController();
  const f = fixture(() => ({ provider: 'codex', async run(options) {
    await options.callbacks.input({ kind: 'permission', title: 'Temporary approval' }, cancel.signal).catch(() => {});
    return 'continued';
  }, async close() {} }));
  try {
    f.store.set('chat', '123'); f.store.createSession('codex', 'ask'); route(f, message(1, 'task')); f.engine.kick();
    await until(() => !!f.store.db.prepare("SELECT 1 FROM requests WHERE state='pending'").get());
    const id = String(f.store.db.prepare('SELECT id FROM requests').get()!.id);
    cancel.abort(); await f.engine.settle(); assert.equal(f.store.request(id)?.state, 'expired');
    route(f, callback(2, `reply:${id}:yes`)); assert.equal(f.store.request(id)?.state, 'expired');
  } finally { await f.close(); }
});

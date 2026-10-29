import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, message, route } from './helpers.ts';
import { deferred } from '../src/process.ts';
import type { AgentCallbacks } from '../src/providers/types.ts';
import { flushOne } from '../src/runtime.ts';
import { TelegramError } from '../src/telegram.ts';
import { Store } from '../src/storage.ts';

test('no acceptance/ID/header messages; stages edit one message, then final replaces it', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => { now += 2100; return now; });
  const done = deferred<string>(); let callbacks!: AgentCallbacks;
  const f = fixture(() => ({ provider: 'codex', async run(options) { callbacks = options.callbacks; return done.promise; }, async close() {} }));
  try {
    f.store.set('chat', '123'); f.store.createSession('codex', 'full');
    route(f, message(1, 'task')); assert.equal(f.store.pendingOutput(), undefined);
    f.engine.kick(); callbacks.progress('Изучаю проект'); await f.engine.progress();
    callbacks.progress('Проверяю изменения'); await f.engine.progress();
    await f.engine.progress(); // same content does not trigger another edit
    assert.equal(f.messenger.sent.length, 1); assert.equal(f.messenger.sent[0].text, 'Изучаю проект');
    assert.deepEqual(f.messenger.edits, [{ id: 1, text: 'Проверяю изменения' }]);
    done.resolve('Готовый ответ'); await f.engine.settle();
    assert.equal(f.store.pendingOutput()?.text, 'Готовый ответ'); assert.equal(f.store.pendingOutput()?.edit_message_id, 1);
    await flushOne(f.store, f.messenger, 123);
    assert.equal(f.messenger.sent.length, 1); assert.deepEqual(f.messenger.edits.at(-1), { id: 1, text: 'Готовый ответ' });
  } finally { done.resolve('done'); await f.close(); }
});
test('final waits for an in-flight progress send and cannot leave a late stage message', async () => {
  const done = deferred<string>(), send = deferred<void>(); let callbacks!: AgentCallbacks;
  const f = fixture(() => ({ provider: 'claude', async run(options) { callbacks = options.callbacks; return done.promise; }, async close() {} }));
  const original = f.messenger.send.bind(f.messenger);
  f.messenger.send = async (...args) => { await send.promise; return original(...args); };
  try {
    f.store.set('chat', '123'); f.store.createSession('claude', 'full'); route(f, message(1, 'task')); f.engine.kick();
    callbacks.progress('Текущий этап'); const progress = f.engine.progress();
    done.resolve('Ответ'); await Promise.resolve();
    assert.equal(f.store.pendingOutput(), undefined);
    send.resolve(); await progress; await f.engine.settle();
    assert.equal(f.store.pendingOutput()?.edit_message_id, 1);
    await flushOne(f.store, f.messenger, 123); assert.equal(f.messenger.sent.length, 1);
    assert.deepEqual(f.messenger.edits.at(-1), { id: 1, text: 'Ответ' });
  } finally { send.resolve(); done.resolve('done'); await f.close(); }
});
test('final without any progress is sent once as plain agent text', async () => {
  const f = fixture(); try {
    f.store.set('chat', '123'); f.store.createSession('codex', 'full'); route(f, message(1, 'task')); f.engine.kick(); await f.engine.settle();
    await flushOne(f.store, f.messenger, 123);
    assert.deepEqual(f.messenger.sent.map(m => m.text), ['Результат']);
  } finally { await f.close(); }
});
test('large final sends attachment and deletes progress; edit rate-limit retries same message', async () => {
  const f = fixture(); try {
    f.store.outgoing('x'.repeat(5000), undefined, undefined, 7);
    await flushOne(f.store, f.messenger, 123); assert.deepEqual(f.messenger.deleted, [7]);
    f.store.outgoing('answer', undefined, undefined, 8);
    f.messenger.edit = async () => { throw new TelegramError(429, 'rate', 3); };
    await flushOne(f.store, f.messenger, 123, 1000);
    assert.equal(f.messenger.sent.length, 1); assert.equal(f.store.pendingOutput()?.edit_message_id, 8);
    assert.equal(f.store.pendingOutput()?.next_at, 4000);
  } finally { await f.close(); }
});
test('deleted progress falls back to sending final; repeated identical edit counts as delivered', async () => {
  const f = fixture(); try {
    f.store.outgoing('answer', undefined, undefined, 7);
    f.messenger.edit = async () => { throw new TelegramError(400, 'Bad Request: message to edit not found'); };
    await flushOne(f.store, f.messenger, 123); assert.equal(f.messenger.sent[0].text, 'answer');
    f.store.outgoing('same answer', undefined, undefined, 8);
    f.messenger.edit = async () => { throw new TelegramError(400, 'Bad Request: message is not modified'); };
    await flushOne(f.store, f.messenger, 123); assert.equal(f.store.pendingOutput(), undefined); assert.equal(f.messenger.sent.length, 1);
  } finally { await f.close(); }
});
test('v1 outbox migrates without losing pending messages, edit target persists across reopen', async () => {
  const f = fixture(); try {
    f.store.outgoing('pending');
    f.store.db.exec('ALTER TABLE outbox DROP COLUMN edit_message_id; PRAGMA user_version=1;');
    const upgraded = new Store(f.config);
    try {
      assert.equal(upgraded.pendingOutput()?.text, 'pending'); assert.equal(upgraded.pendingOutput()?.edit_message_id, null);
      upgraded.db.prepare('UPDATE outbox SET edit_message_id=23').run();
    } finally { upgraded.close(); }
    const reopened = new Store(f.config);
    try { assert.equal(reopened.pendingOutput()?.edit_message_id, 23); } finally { reopened.close(); }
  } finally { await f.close(); }
});

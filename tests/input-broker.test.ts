import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { fixture, message, route } from './helpers.ts';
import { InputBroker } from '../src/input-broker.ts';
import { Interrupted } from '../src/providers/types.ts';
import { TelegramError } from '../src/telegram.ts';
import { flushOne } from '../src/runtime.ts';

test('input broker persists permission before waiting and releases its abort listener after answer', async () => {
  const f = fixture(), abort = new AbortController();
  const broker = new InputBroker(f.store);
  try {
    const session = f.store.createSession('codex', 'ask');
    const job = f.store.enqueue(1, session, 'permission', null, 17);
    f.store.state(job.id, 'running');
    const pending = broker.ask(job.id, { kind: 'permission', title: 'Edit?' }, abort.signal);
    const output = f.store.pendingOutput()!, id = output.request_id!;
    assert.equal(f.store.job(job.id)?.state, 'waiting_input');
    assert.equal(output.reply_to_message_id, 17); assert.equal(broker.lookup(id)?.kind, 'permission');
    f.store.tx(() => { f.store.db.prepare("UPDATE requests SET state='answered' WHERE id=?").run(id); });
    broker.answer(id, { allow: false });
    assert.deepEqual(await pending, { allow: false });
    assert.equal(broker.lookup(id), undefined); assert.equal(f.store.job(job.id)?.state, 'running');
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  } finally { abort.abort(); await f.close(); }
});

test('input broker asks multiple questions sequentially and keeps answer identifiers', async () => {
  const f = fixture(), abort = new AbortController(), broker = new InputBroker(f.store);
  try {
    const s = f.store.createSession('claude', 'full'), job = f.store.enqueue(1, s, 'questions', null);
    f.store.state(job.id, 'running');
    const pending = broker.ask(job.id, { kind: 'question', title: 'Choose', questions: [{ id: 'one', text: 'First?' }, { id: 'two', text: 'Second?' }] }, abort.signal);
    const first = String(f.store.db.prepare('SELECT id FROM requests').get()!.id);
    assert.equal(broker.lookup(first)?.questionId, 'one');
    f.store.db.prepare("UPDATE requests SET state='answered' WHERE id=?").run(first);
    broker.answer(first, { answers: { one: 'A' } });
    await Promise.resolve();
    const second = String(f.store.db.prepare('SELECT id FROM requests ORDER BY rowid DESC LIMIT 1').get()!.id);
    assert.notEqual(first, second); assert.equal(broker.lookup(second)?.questionId, 'two');
    f.store.db.prepare("UPDATE requests SET state='answered' WHERE id=?").run(second);
    broker.answer(second, { answers: { two: 'B' } });
    assert.deepEqual(await pending, { answers: { one: 'A', two: 'B' } });
  } finally { abort.abort(); await f.close(); }
});

test('input timeout expires durable request and removes the waiter', async () => {
  const f = fixture(), broker = new InputBroker(f.store, { timeoutMs: 10 });
  try {
    const s = f.store.createSession('codex', 'ask'), job = f.store.enqueue(1, s, 'timeout', null);
    f.store.state(job.id, 'running');
    const pending = broker.ask(job.id, { kind: 'permission', title: 'Wait' }, new AbortController().signal);
    const id = f.store.pendingOutput()!.request_id!;
    await assert.rejects(() => pending, /Истекло время/);
    assert.equal(f.store.request(id)?.state, 'expired'); assert.equal(broker.lookup(id), undefined);
  } finally { await f.close(); }
});

test('cancelling an input still settles its promise when storing the state fails', async t => {
  const f = fixture(), abort = new AbortController(); let fatal: Error | undefined;
  const broker = new InputBroker(f.store, { onFatal: error => { fatal = error; } });
  try {
    const s = f.store.createSession('codex', 'ask'), job = f.store.enqueue(1, s, 'stop', null);
    f.store.state(job.id, 'running');
    const pending = broker.ask(job.id, { kind: 'permission', title: 'Wait' }, abort.signal);
    const id = f.store.pendingOutput()!.request_id!;
    const rejected = assert.rejects(() => pending, Interrupted);
    t.mock.method(f.store, 'state', () => { throw new Error('database full'); });
    abort.abort(); await rejected;
    assert.equal(fatal?.message, 'database full'); assert.equal(broker.lookup(id), undefined);
    assert.equal(f.store.request(id)?.state, 'expired');
  } finally { abort.abort(); await f.close(); }
});

test('job cleanup rejects only that job and leaves another session permission answerable', async () => {
  const f = fixture(), abort = new AbortController(), broker = new InputBroker(f.store);
  try {
    const s = f.store.createSession('codex', 'ask'), a = f.store.enqueue(1, s, 'A', null), b = f.store.enqueue(2, s, 'B', null);
    f.store.state(a.id, 'running'); f.store.state(b.id, 'running');
    const first = broker.ask(a.id, { kind: 'permission', title: 'A' }, abort.signal);
    const second = broker.ask(b.id, { kind: 'permission', title: 'B' }, abort.signal);
    const rejected = assert.rejects(() => first, Interrupted);
    broker.rejectForJob(a.id); await rejected;
    const id = String(f.store.db.prepare('SELECT id FROM requests WHERE job_id=?').get(b.id)!.id);
    assert.ok(broker.lookup(id));
    f.store.db.prepare("UPDATE requests SET state='answered' WHERE id=?").run(id); broker.answer(id, { allow: true });
    assert.deepEqual(await second, { allow: true });
  } finally { abort.abort(); await f.close(); }
});

test('failed permission delivery releases the engine promptly and information reports undelivered output', async () => {
  const f = fixture(() => ({ provider: 'codex', async run(options) {
    await options.callbacks.input({ kind: 'permission', title: 'Permission' }); return 'unexpected';
  }, async close() {} }));
  try {
    f.store.set('chat', '123'); f.store.createSession('codex', 'ask'); route(f, message(1, 'task')); f.engine.kick();
    assert.equal(f.engine.activeCount, 1);
    f.messenger.send = async () => { throw new TelegramError(400, 'cannot deliver permission'); };
    await flushOne(f.store, f.messenger, 123); f.engine.kick(); await f.engine.settle();
    assert.equal(f.engine.activeCount, 0); assert.equal(f.engine.fatal, undefined);
    assert.match(String(f.store.db.prepare('SELECT result FROM jobs').get()!.result), /не доставлен/);
    assert.match(await f.engine.information(), /Недоставленных сообщений: 1/);
  } finally { await f.close(); }
});

test('broker poll settles waiters and reports a storage read failure', async t => {
  const f = fixture(); let fatal: Error | undefined;
  const broker = new InputBroker(f.store, { onFatal: error => { fatal = error; } });
  try {
    const s = f.store.createSession('codex', 'ask'), job = f.store.enqueue(1, s, 'poll', null);
    f.store.state(job.id, 'running');
    const pending = broker.ask(job.id, { kind: 'permission', title: 'Wait' }, new AbortController().signal);
    const rejected = assert.rejects(() => pending, /read failed/);
    t.mock.method(f.store, 'request', () => { throw new Error('read failed'); });
    broker.poll(); await rejected; assert.equal(fatal?.message, 'read failed');
  } finally { await f.close(); }
});

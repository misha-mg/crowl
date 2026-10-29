import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, message, callback, route, until } from './helpers.ts';
import { deferred } from '../src/process.ts';
import type { AgentRun } from '../src/providers/types.ts';
import { Interrupted, Uncertain } from '../src/providers/types.ts';
import { flushOne } from '../src/runtime.ts';
import { Store } from '../src/storage.ts';

function controlled() {
  const calls = new Map<string, AgentRun>(), gates = new Map<string, ReturnType<typeof deferred<string>>>();
  const f = fixture(() => ({ provider: 'codex', async run(options) {
    calls.set(options.prompt, options);
    options.callbacks.nativeId(options.nativeId ?? `native-${options.prompt}`);
    const gate = deferred<string>(); gates.set(options.prompt, gate);
    const abort = () => gate.reject(new Interrupted());
    options.signal.addEventListener('abort', abort, { once: true });
    try { return await gate.promise; } finally { options.signal.removeEventListener('abort', abort); }
  }, async close() {} }));
  f.store.set('chat', '123');
  return { ...f, calls, finish: (prompt: string) => gates.get(prompt)!.resolve(`answer-${prompt}`) };
}
function newSession(f: ReturnType<typeof fixture>, update: number, provider = 'claude') {
  route(f, message(update, '/new'));
  route(f, callback(update + 1, `new:${provider}:${f.store.get('chooser')}`));
  return f.store.session()!;
}

test('new session runs while old task continues; normal final messages retain internal session bindings', async () => {
  const f = controlled(); try {
    const a = f.store.createSession('codex', 'full'); route(f, message(101, 'A')); f.engine.kick();
    const b = newSession(f, 102); route(f, message(104, 'B')); f.engine.kick();
    assert.equal(f.engine.activeCount, 2); assert.equal(f.calls.get('A')!.signal.aborted, false);
    assert.notEqual(a.id, b.id); assert.equal(f.calls.get('B')!.nativeId, null);
    f.finish('B'); await until(() => f.engine.activeCount === 1);
    assert.equal(f.store.db.prepare("SELECT state FROM jobs WHERE text='A'").get()!.state, 'running');
    f.finish('A'); await f.engine.settle();
    while (await flushOne(f.store, f.messenger, 123)) {}
    assert.equal(f.store.sessionForMessage(f.messenger.sent.find(m => m.text === 'answer-A')!.id), a.id);
    assert.equal(f.store.sessionForMessage(f.messenger.sent.find(m => m.text === 'answer-B')!.id), b.id);
    assert.equal(f.store.session(a.id)?.native_id, 'native-A'); assert.equal(f.store.session(b.id)?.native_id, 'native-B');
  } finally { await f.close(); }
});
test('switching to a running saved session does not interrupt either agent; stop targets only focus', async () => {
  const f = controlled(); try {
    const a = f.store.createSession('codex', 'full'); route(f, message(1, 'A')); f.engine.kick();
    const b = newSession(f, 2); route(f, message(4, 'B')); f.engine.kick();
    route(f, callback(5, `session:${a.id}`)); assert.equal(f.store.session()?.id, a.id);
    assert.equal(f.calls.get('A')!.signal.aborted, false); assert.equal(f.calls.get('B')!.signal.aborted, false);
    route(f, message(6, '/stop')); await until(() => f.engine.activeCount === 1);
    assert.equal(f.calls.get('A')!.signal.aborted, true); assert.equal(f.calls.get('B')!.signal.aborted, false);
    assert.equal(f.store.pausedFor(a.id), true); assert.equal(f.store.pausedFor(b.id), false);
    f.finish('B'); await f.engine.settle();
  } finally { await f.close(); }
});
test('close affects only selected session and its queue; another running session remains available', async () => {
  const f = controlled(); try {
    const a = f.store.createSession('codex', 'full'); route(f, message(1, 'A')); route(f, message(2, 'A-next')); f.engine.kick();
    const b = newSession(f, 3); route(f, message(5, 'B')); route(f, message(6, 'B-next')); f.engine.kick();
    route(f, message(7, '/close')); await until(() => f.engine.activeCount === 1);
    assert.equal(f.calls.get('A')!.signal.aborted, false); assert.equal(f.calls.get('B')!.signal.aborted, true);
    assert.equal(f.store.queue(a.id).length, 1); assert.equal(f.store.queue(b.id).length, 0);
    route(f, callback(8, `session:${a.id}`)); assert.equal(f.store.session()?.id, a.id);
    f.finish('A'); await f.engine.settle(); f.engine.kick(); assert.ok(f.calls.has('A-next'));
    assert.equal(f.calls.get('A-next')!.nativeId, 'native-A'); f.finish('A-next'); await f.engine.settle();
  } finally { await f.close(); }
});
test('each session preserves FIFO and concurrency limit queues other sessions without stopping tasks', async () => {
  const f = controlled(); try {
    f.config.maxConcurrentSessions = 1;
    const a = f.store.createSession('codex', 'full'); route(f, message(1, 'A')); route(f, message(2, 'A-next')); f.engine.kick();
    newSession(f, 3); route(f, message(5, 'B')); f.engine.kick();
    assert.equal(f.engine.activeCount, 1); assert.ok(!f.calls.has('B')); assert.ok(!f.calls.has('A-next'));
    f.finish('A'); await f.engine.settle(); f.engine.kick(); assert.ok(f.calls.has('A-next')); assert.ok(!f.calls.has('B'));
    assert.equal(f.store.queue(a.id).length, 0); f.finish('A-next'); await f.engine.settle(); f.engine.kick();
    assert.ok(f.calls.has('B')); f.finish('B'); await f.engine.settle();
  } finally { await f.close(); }
});
test('queue actions are session-bound and cannot delete another session waiting jobs', async () => {
  const f = fixture(); try {
    f.store.set('chat', '123'); const a = f.store.createSession('codex', 'full'); route(f, message(1, 'A')); route(f, message(2, '/queue'));
    const old = f.store.get('queue_menu'); const b = newSession(f, 3); route(f, message(5, 'B'));
    route(f, callback(6, `queue:drop:${old}`)); assert.equal(f.store.queue(a.id).length, 1); assert.equal(f.store.queue(b.id).length, 1);
    route(f, message(7, '/queue')); route(f, callback(8, `queue:drop:${f.store.get('queue_menu')}`));
    assert.equal(f.store.queue(a.id).length, 1); assert.equal(f.store.queue(b.id).length, 0);
  } finally { await f.close(); }
});
test('background permission response is routed to its own job after focus changes', async () => {
  const f = fixture(() => ({ provider: 'codex', async run(options) {
    return (await options.callbacks.input({ kind: 'permission', title: `approve ${options.prompt}` })).allow ? options.prompt : 'denied';
  }, async close() {} }));
  try {
    f.store.set('chat', '123'); const a = f.store.createSession('codex', 'ask'); route(f, message(1, 'A')); f.engine.kick();
    const requestA = String(f.store.db.prepare('SELECT id FROM requests ORDER BY rowid LIMIT 1').get()!.id);
    newSession(f, 2); route(f, message(4, 'B')); f.engine.kick(); assert.equal(f.engine.activeCount, 2);
    route(f, callback(5, `reply:${requestA}:yes`)); await until(() => f.engine.activeCount === 1);
    assert.equal(f.store.db.prepare('SELECT result FROM jobs WHERE session_id=?').get(a.id)!.result, 'A');
    route(f, message(6, '/stop')); await f.engine.settle();
    assert.equal(f.store.db.prepare("SELECT state FROM jobs WHERE text='B'").get()!.state, 'interrupted');
  } finally { await f.close(); }
});
test('one uncertain session pauses only itself; other session continues scheduling', async () => {
  const f = fixture(() => ({ provider: 'codex', async run(options) { if (options.prompt === 'A') throw new Uncertain(); return 'B complete'; }, async close() {} }));
  try {
    f.store.set('chat', '123'); const a = f.store.createSession('codex', 'full'); route(f, message(1, 'A')); route(f, message(2, 'A-next'));
    const b = newSession(f, 3); route(f, message(5, 'B')); f.engine.kick(); await f.engine.settle();
    assert.equal(f.store.pausedFor(a.id), true); assert.equal(f.store.pausedFor(b.id), false);
    assert.equal(f.store.queue(a.id).length, 1); assert.equal(f.store.db.prepare("SELECT state FROM jobs WHERE text='B'").get()!.state, 'completed');
  } finally { await f.close(); }
});
test('progress belongs to each job and is edited independently after focus switches', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => { now += 2200; return now; });
  const f = controlled(); try {
    const a = f.store.createSession('codex', 'full'); route(f, message(1, 'A')); f.engine.kick();
    const b = newSession(f, 2); route(f, message(4, 'B')); f.engine.kick();
    f.calls.get('A')!.callbacks.progress('stage A'); f.calls.get('B')!.callbacks.progress('stage B');
    await f.engine.progress(); await f.engine.progress();
    assert.equal(f.store.sessionForMessage(f.messenger.sent.find(m => m.text === 'stage A')!.id), a.id);
    assert.equal(f.store.sessionForMessage(f.messenger.sent.find(m => m.text === 'stage B')!.id), b.id);
    f.finish('A'); f.finish('B'); await f.engine.settle(); while (await flushOne(f.store, f.messenger, 123)) {}
    const idA = f.messenger.sent.find(m => m.text === 'stage A')!.id, idB = f.messenger.sent.find(m => m.text === 'stage B')!.id;
    assert.ok(f.messenger.edits.some(m => m.id === idA && m.text === 'answer-A'));
    assert.ok(f.messenger.edits.some(m => m.id === idB && m.text === 'answer-B'));
    assert.notEqual(idA, idB); assert.equal(f.store.session(a.id)?.native_id, 'native-A');
  } finally { await f.close(); }
});
test('recovery pauses only interrupted sessions and preserves prompt reply targets', async () => {
  const f = fixture(); try {
    const a = f.store.createSession('codex', 'full'), b = f.store.createSession('claude', 'full');
    const job = f.store.enqueue(1, a, 'A', null, 111); f.store.state(job.id, 'running');
    f.store.enqueue(2, b, 'B', null, 222); f.store.recover();
    assert.equal(f.store.pausedFor(a.id), true); assert.equal(f.store.pausedFor(b.id), false);
    const reopened = new Store(f.config);
    try { assert.equal(reopened.job(job.id)?.origin_message_id, 111); } finally { reopened.close(); }
  } finally { await f.close(); }
});
test('Reply to a background final continues its session without changing focus', async () => {
  const f = fixture(); try {
    f.store.set('chat', '123'); const a = f.store.createSession('codex', 'full'); route(f, message(101, 'A')); f.engine.kick(); await f.engine.settle();
    await flushOne(f.store, f.messenger, 123); const answer = f.messenger.sent[0].id;
    const b = newSession(f, 102);
    route(f, message(104, 'Follow up A', 123, answer));
    assert.equal(f.store.session()?.id, b.id); assert.equal(f.store.queue(a.id)[0].text, 'Follow up A'); assert.equal(f.store.queue(b.id).length, 0);
    f.engine.kick(); await f.engine.settle(); assert.equal(f.prompts.at(-1)?.nativeId, 'native-1');
    const reopened = new Store(f.config);
    try { assert.equal(reopened.sessionForMessage(answer), a.id); } finally { reopened.close(); }
  } finally { await f.close(); }
});
test('Reply to background progress queues behind its task, including a voice message', async () => {
  const f = controlled(); try {
    const a = f.store.createSession('codex', 'full'); route(f, message(101, 'A')); f.engine.kick();
    f.calls.get('A')!.callbacks.progress('Stage A'); await f.engine.progress();
    const progress = f.messenger.sent[0].id; const b = newSession(f, 102);
    route(f, message(104, 'A next', 123, progress));
    route(f, { update_id: 105, message: { ...message(105, '').message!, text: undefined, reply_to_message: { message_id: progress }, voice: { file_id: 'voice-A', duration: 3 } } });
    f.engine.kick(); assert.equal(f.engine.activeCount, 1);
    assert.equal(f.store.queue(a.id).length, 2); assert.equal(f.store.queue(b.id).length, 0); assert.ok(f.store.queue(a.id)[1].voice);
    f.finish('A'); await f.engine.settle();
  } finally { await f.close(); }
});
test('switching focus does not automatically resume a stopped queue', async () => {
  const f = controlled(); try {
    const a = f.store.createSession('codex', 'full'); route(f, message(1, 'A')); route(f, message(2, 'A-next')); f.engine.kick();
    route(f, message(3, '/stop')); await f.engine.settle();
    const b = newSession(f, 4); route(f, callback(6, `session:${a.id}`)); f.engine.kick();
    assert.equal(f.store.pausedFor(a.id), true); assert.ok(!f.calls.has('A-next')); assert.equal(f.engine.activeCount, 0);
    route(f, message(7, '/queue')); route(f, callback(8, `queue:resume:${f.store.get('queue_menu')}`)); f.engine.kick();
    assert.ok(f.calls.has('A-next')); assert.equal(f.store.pausedFor(b.id), false); f.finish('A-next'); await f.engine.settle();
  } finally { await f.close(); }
});
test('shutdown interrupts all running sessions and preserves each session pending queue', async () => {
  const f = controlled(); try {
    const a = f.store.createSession('codex', 'full'); route(f, message(1, 'A')); route(f, message(2, 'A-next')); f.engine.kick();
    const b = newSession(f, 3); route(f, message(5, 'B')); route(f, message(6, 'B-next')); f.engine.kick();
    await f.engine.stop();
    assert.equal(f.calls.get('A')!.signal.aborted, true); assert.equal(f.calls.get('B')!.signal.aborted, true);
    assert.equal(f.store.queue(a.id).length, 1); assert.equal(f.store.queue(b.id).length, 1);
    assert.equal(f.store.pausedFor(a.id), true); assert.equal(f.store.pausedFor(b.id), true);
    assert.equal(f.engine.activeCount, 0);
  } finally { await f.close(); }
});
test('shutdown cancels every agent even if pause writes fail', async () => {
  const f = controlled(), original = f.store.setPaused;
  try {
    f.store.createSession('codex', 'full'); route(f, message(1, 'A')); f.engine.kick();
    newSession(f, 2); route(f, message(4, 'B')); f.engine.kick();
    f.store.setPaused = () => { throw new Error('simulated disk full'); };
    await f.engine.stop();
    assert.equal(f.calls.get('A')!.signal.aborted, true); assert.equal(f.calls.get('B')!.signal.aborted, true);
    assert.equal(f.engine.activeCount, 0); assert.match(f.engine.fatal!.message, /disk full/);
  } finally { f.store.setPaused = original; await f.close(); }
});
test('a database failure while cancelling a pending input cannot strand shutdown', async () => {
  const f = fixture(() => ({ provider: 'codex', async run(options) { await options.callbacks.input({ kind: 'permission', title: 'Wait' }); return 'bad'; }, async close() {} }));
  const original = f.store.state;
  try {
    f.store.set('chat', '123'); f.store.createSession('codex', 'ask'); route(f, message(1, 'task')); f.engine.kick();
    await until(() => !!f.store.db.prepare("SELECT 1 FROM requests WHERE state='pending'").get());
    f.store.state = () => { throw new Error('simulated failed state write'); };
    await f.engine.stop(); assert.equal(f.engine.activeCount, 0); assert.ok(f.engine.fatal);
  } finally { f.store.state = original; await f.close(); }
});
test('unmapped Reply is rejected rather than sent to the currently focused agent', async () => {
  const f = fixture(); try {
    f.store.set('chat', '123'); f.store.createSession('codex', 'full');
    route(f, message(1, 'follow up unknown history', 123, 999));
    assert.equal(f.store.queue().length, 0); assert.match(f.store.pendingOutput()!.text, /Сессия этого сообщения неизвестна/);
  } finally { await f.close(); }
});

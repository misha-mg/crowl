import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, message, route, until } from './helpers.ts';
import { deferred } from '../src/process.ts';
import { flushOne } from '../src/runtime.ts';
import { Telegram } from '../src/telegram.ts';

test('typing heartbeat is renewed while thinking and stops after completion', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const done = deferred<string>();
  const f = fixture(() => ({ provider: 'codex', async run() { return done.promise; }, async close() {} }));
  try {
    f.store.set('chat', '123'); f.store.createSession('codex', 'full');
    await f.engine.typing(); assert.equal(f.messenger.typingCalls.length, 0);
    route(f, message(1, 'task')); f.engine.kick();
    await f.engine.typing(); assert.deepEqual(f.messenger.typingCalls, [123]);
    now += 3999; await f.engine.typing(); assert.equal(f.messenger.typingCalls.length, 1);
    now++; await f.engine.typing(); assert.equal(f.messenger.typingCalls.length, 2);
    done.resolve('Answer'); await f.engine.settle(); now += 5000; await f.engine.typing();
    assert.equal(f.messenger.typingCalls.length, 2);
  } finally { done.resolve('done'); await f.close(); }
});
test('typing is not shown while waiting for the owner and failures do not fail an agent task', async () => {
  const f = fixture(() => ({ provider: 'codex', async run(options) { await options.callbacks.input({ kind: 'permission', title: 'Approve?' }); return 'done'; }, async close() {} }));
  try {
    f.store.set('chat', '123'); f.store.createSession('codex', 'ask'); route(f, message(1, 'task')); f.engine.kick();
    await until(() => !!f.store.db.prepare("SELECT 1 FROM requests WHERE state='pending'").get());
    await f.engine.typing(); assert.equal(f.messenger.typingCalls.length, 0);
    route(f, message(2, '/stop')); await f.engine.settle();
  } finally { await f.close(); }
  const done = deferred<string>(); const other = fixture(() => ({ provider: 'codex', async run() { return done.promise; }, async close() {} }));
  try {
    other.messenger.typing = async () => { throw new Error('Telegram unavailable'); };
    other.store.set('chat', '123'); other.store.createSession('codex', 'full'); route(other, message(1, 'task')); other.engine.kick();
    await other.engine.typing(); done.resolve('Answer'); await other.engine.settle();
    assert.equal(other.store.pendingOutput()?.text, 'Answer'); assert.equal(other.engine.fatal, undefined);
  } finally { done.resolve('done'); await other.close(); }
});
test('typing requests cannot overlap when Telegram responds slowly', async () => {
  const done = deferred<string>(), delivered = deferred<void>(); let calls = 0;
  const f = fixture(() => ({ provider: 'codex', async run() { return done.promise; }, async close() {} }));
  try {
    f.store.set('chat', '123'); f.store.createSession('codex', 'full'); route(f, message(1, 'task')); f.engine.kick();
    f.messenger.typing = async () => { calls++; await delivered.promise; };
    const pending = f.engine.typing(); await f.engine.typing(); assert.equal(calls, 1);
    delivered.resolve(); await pending; done.resolve('done'); await f.engine.settle();
  } finally { delivered.resolve(); done.resolve('done'); await f.close(); }
});
test('Telegram typing uses sendChatAction without creating a chat message', async () => {
  const calls: { url: string; body: any }[] = [];
  const telegram = new Telegram('token', (async (url, options) => { calls.push({ url: String(url), body: JSON.parse(String(options?.body)) }); return Response.json({ ok: true, result: true }); }) as typeof fetch);
  await telegram.typing(123);
  assert.match(calls[0].url, /sendChatAction$/); assert.deepEqual(calls[0].body, { chat_id: 123, action: 'typing' });
});
test('voice decoding, agent progress and final occupy one normal message without a transcript reply', async t => {
  const done = deferred<string>(); let started = false;
  const f = fixture(() => ({ provider: 'codex', async run(options) {
    assert.equal(options.prompt, 'Исправь API'); started = true; options.callbacks.progress('Проверяю API'); return done.promise;
  }, async close() {} }));
  try {
    // Model Telegram's real restriction: messages sent with a reply keyboard
    // cannot be edited. Exercise the actual serializer, not just FakeMessenger.
    const messages = new Map<number, any>();
    const telegram = new Telegram('token', (async (url, options) => {
      const params = JSON.parse(String(options?.body));
      if (String(url).endsWith('/sendMessage')) {
        const id = messages.size + 1; messages.set(id, params);
        return Response.json({ ok: true, result: { message_id: id } });
      }
      if (String(url).endsWith('/editMessageText') && messages.get(params.message_id)?.reply_markup?.keyboard)
        return Response.json({ ok: false, error_code: 400, description: "Bad Request: message can't be edited" });
      return Response.json({ ok: true, result: true });
    }) as typeof fetch);
    const send = f.messenger.send.bind(f.messenger), edit = f.messenger.edit.bind(f.messenger);
    f.messenger.send = async (chat, text, buttons) => { await telegram.send(chat, text, buttons); return send(chat, text, buttons); };
    f.messenger.edit = async (chat, id, text) => { await telegram.edit(chat, id, text); await edit(chat, id, text); };
    const tool = join(f.dir, 'audio-tool');
    writeFileSync(tool, "#!/usr/bin/env node\nimport{writeFileSync}from'node:fs';const a=process.argv.slice(2);if(a.includes('-otxt'))setTimeout(()=>writeFileSync(a[a.indexOf('-of')+1]+'.txt','Исправь API'),150);else writeFileSync(a.at(-1),'wav');\n");
    chmodSync(tool, 0o700); const model = join(f.dir, 'model.bin'); writeFileSync(model, 'fake model');
    Object.assign(f.config, { ffmpeg: tool, whisper: tool, model });
    f.store.set('chat', '123'); const session = f.store.createSession('codex', 'full');
    route(f, { update_id: 101, message: { ...message(101, '').message!, text: undefined, voice: { file_id: 'voice', duration: 2 } } });
    f.engine.kick(); await f.engine.typing(); await f.engine.progress();
    assert.equal(f.messenger.sent.length, 1); assert.equal(f.messenger.sent[0].text, 'Расшифровываю…');
    assert.equal(f.messenger.sent[0].replyToMessageId, undefined);
    assert.equal(messages.get(1).reply_markup, undefined);
    await until(() => started);
    assert.equal(f.store.pendingOutput(), undefined); // transcript is internal, never a separate chat message
    const now = Date.now() + 2500; t.mock.method(Date, 'now', () => now);
    await f.engine.progress(); assert.equal(f.messenger.sent.length, 1);
    assert.deepEqual(f.messenger.edits.at(-1), { id: 1, text: 'Проверяю API' });
    done.resolve('Исправлено'); await f.engine.settle(); await flushOne(f.store, f.messenger, 123);
    assert.equal(f.messenger.sent.length, 1); assert.deepEqual(f.messenger.edits.at(-1), { id: 1, text: 'Исправлено' });
    assert.equal(f.store.sessionForMessage(1), session.id);
  } finally { done.resolve('done'); await f.close(); }
});

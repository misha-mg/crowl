import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telegram, TelegramError, authorized } from '../src/telegram.ts';
import { flushOne } from '../src/runtime.ts';
import { fixture, message, callback } from './helpers.ts';

test('authorization rejects groups and forged callbacks', () => {
  assert.ok(authorized(message(1, 'x'), 123));
  assert.ok(!authorized(message(1, 'x', 555), 123));
  assert.ok(!authorized(callback(1, 'reply:any:yes', 555), 123));
  assert.ok(!authorized({ update_id: 1, message: { ...message(1, 'x').message!, chat: { id: 123, type: 'group' } } }, 123));
  assert.ok(!authorized(message(1, 'x'), 123, 555));
});
test('Telegram rate limits expose retry_after, network errors hide token', async () => {
  const token = '123:abcdefghijklmnopqrstuvwxyz';
  const rate = new Telegram(token, (async () => Response.json({ ok: false, error_code: 429, description: 'rate', parameters: { retry_after: 12 } })) as typeof fetch);
  await assert.rejects(() => rate.send(123, 'x'), error => error instanceof TelegramError && error.code === 429 && error.retryAfter === 12);
  const network = new Telegram(token, (async () => { throw new Error(`Error https://api.telegram.org/bot${token}/sendMessage`); }) as typeof fetch);
  await assert.rejects(() => network.send(123, 'x'), error => error instanceof Error && !error.message.includes(token));
});
test('large replies use one multipart document; text remains plain', async () => {
  const calls: { url: string; body: any }[] = [];
  const telegram = new Telegram('token', (async (url, opts) => { calls.push({ url: String(url), body: opts?.body }); return Response.json({ ok: true, result: { message_id: 7 } }); }) as typeof fetch);
  assert.equal(await telegram.send(123, '<hello>_world'), 7);
  assert.equal(JSON.parse(calls[0].body).parse_mode, undefined);
  await telegram.send(123, 'x'.repeat(6000)); assert.match(calls[1].url, /sendDocument$/); assert.ok(calls[1].body instanceof FormData);
});
test('outbox retries delivery without executing task again', async () => {
  const f = fixture(); try {
    f.store.outgoing('result');
    const messenger = { ...f.messenger, send: async () => { throw new TelegramError(429, 'rate', 3); } };
    assert.equal(await flushOne(f.store, messenger as any, 123, 1000), false);
    assert.equal(f.store.pendingOutput()?.next_at, 4000); assert.equal(f.store.pendingOutput()?.attempts, 1);
    assert.equal(await flushOne(f.store, f.messenger, 123, 2000), false);
    assert.equal(await flushOne(f.store, f.messenger, 123, 4001), true); assert.equal(f.store.pendingOutput(), undefined); assert.equal(f.prompts.length, 0);
  } finally { await f.close(); }
});
test('expired permission prompts are not sent after restart', async () => {
  const f = fixture(); try {
    const session = f.store.createSession('codex', 'full'), job = f.store.enqueue(1, session, 'x', null);
    f.store.db.prepare("INSERT INTO requests VALUES ('r',?,'permission','x',NULL,'expired',?)").run(job.id, Date.now());
    f.store.outgoing('stale prompt', undefined, 'r'); await flushOne(f.store, f.messenger, 123);
    assert.equal(f.messenger.sent.length, 0); assert.equal(f.store.pendingOutput(), undefined);
  } finally { await f.close(); }
});
test('voice download validates path and enforces streaming size limit', async () => {
  let calls = 0;
  const telegram = new Telegram('token', (async () => { calls++; return calls === 1 ? Response.json({ ok: true, result: { file_path: 'voice/test.ogg', file_size: 1 } }) : new Response(new Uint8Array(12)); }) as typeof fetch);
  await assert.rejects(() => telegram.download('x', 10), /превышает/);
  const bad = new Telegram('token', (async () => Response.json({ ok: true, result: { file_path: '../secret' } })) as typeof fetch);
  await assert.rejects(() => bad.download('x', 10), /Некорректный/);
});
test('text and document results are normal messages without Telegram reply metadata', async () => {
  const bodies: any[] = [];
  const telegram = new Telegram('token', (async (_url, opts) => { bodies.push(opts?.body); return Response.json({ ok: true, result: { message_id: 42 } }); }) as typeof fetch);
  await telegram.send(123, 'answer');
  assert.equal(JSON.parse(bodies[0]).reply_parameters, undefined);
  await telegram.send(123, 'x'.repeat(5000));
  assert.equal(bodies[1].get('reply_parameters'), null);
});
test('download stream errors redact the bot token as well as initial fetch errors', async () => {
  const token = '123:abcdefghijklmnopqrstuvwxyz'; let calls = 0;
  const telegram = new Telegram(token, (async () => {
    if (++calls === 1) return Response.json({ ok: true, result: { file_path: 'voice/test.ogg', file_size: 1 } });
    return new Response(new ReadableStream({ start(controller) { controller.error(new Error(`read failed https://api.telegram.org/file/bot${token}/voice/test.ogg`)); } }));
  }) as typeof fetch);
  await assert.rejects(() => telegram.download('voice', 20_000_000), error => error instanceof Error && !error.message.includes(token) && error.message.includes('[TOKEN]'));
});

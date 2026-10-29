import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { flushOne, MAX_DELIVERY_ATTEMPTS } from '../src/runtime.ts';
import { Telegram, TelegramError } from '../src/telegram.ts';

test('permanent delivery failure preserves the payload and lets following messages through', async () => {
  const f = fixture();
  try {
    f.store.outgoing('cannot deliver'); f.store.outgoing('next response');
    const failed = f.store.pendingOutput()!;
    const send = f.messenger.send.bind(f.messenger);
    f.messenger.send = async (chat, text, buttons, reply) => {
      if (text === 'cannot deliver') throw new TelegramError(400, 'Bad Request: invalid payload');
      return send(chat, text, buttons, reply);
    };
    assert.equal(await flushOne(f.store, f.messenger, 123, 1000), true);
    const saved = f.store.db.prepare('SELECT * FROM outbox WHERE id=?').get(failed.id)!;
    assert.equal(saved.text, 'cannot deliver'); assert.equal(saved.sent, 0);
    assert.equal(saved.failed_at, 1000); assert.match(String(saved.last_error), /invalid payload/);
    assert.equal(await flushOne(f.store, f.messenger, 123, 1100), true);
    assert.equal(f.messenger.sent[0].text, 'next response'); assert.equal(f.store.pendingOutput(), undefined);
  } finally { await f.close(); }
});

test('transient delivery eventually becomes recoverable failure instead of blocking forever', async () => {
  const f = fixture();
  try {
    f.store.outgoing('retry me'); const id = f.store.pendingOutput()!.id;
    f.messenger.send = async () => { throw new Error('network unavailable'); };
    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
      assert.equal(await flushOne(f.store, f.messenger, 123, 1000 + attempt * 100_000), attempt === MAX_DELIVERY_ATTEMPTS - 1);
    }
    const saved = f.store.db.prepare('SELECT * FROM outbox WHERE id=?').get(id)!;
    assert.equal(saved.attempts, MAX_DELIVERY_ATTEMPTS); assert.ok(saved.failed_at);
    assert.equal(saved.text, 'retry me'); assert.equal(f.store.pendingOutput(), undefined);
  } finally { await f.close(); }
});

test('rate limits do not exhaust delivery retries and retain retry_after', async () => {
  const f = fixture();
  try {
    f.store.outgoing('throttled'); const id = f.store.pendingOutput()!.id;
    f.store.db.prepare('UPDATE outbox SET attempts=100 WHERE id=?').run(id);
    f.messenger.send = async () => { throw new TelegramError(429, 'rate limit', 17); };
    assert.equal(await flushOne(f.store, f.messenger, 123, 1000), false);
    assert.equal(f.store.pendingOutput()?.next_at, 18_000);
    assert.equal(f.store.db.prepare('SELECT failed_at FROM outbox WHERE id=?').get(id)!.failed_at, null);
    assert.equal(f.store.pendingOutput()?.failure_count, 0);
    f.messenger.send = async () => { throw new Error('temporary disconnect after throttling'); };
    assert.equal(await flushOne(f.store, f.messenger, 123, 20_000), false);
    assert.equal(f.store.pendingOutput()?.failure_count, 1);
    assert.equal(f.store.db.prepare('SELECT failed_at FROM outbox WHERE id=?').get(id)!.failed_at, null);
  } finally { await f.close(); }
});

test('permanent question delivery failure expires its pending request', async () => {
  const f = fixture();
  try {
    const s = f.store.createSession('codex', 'ask'); const job = f.store.enqueue(1, s, 'ask', null);
    f.store.db.prepare("INSERT INTO requests VALUES ('pending-request',?,'question','Question',NULL,'pending',?)").run(job.id, Date.now());
    f.store.outgoing('Question', undefined, 'pending-request');
    f.messenger.send = async () => { throw new TelegramError(400, 'invalid question'); };
    await flushOne(f.store, f.messenger, 123);
    assert.equal(f.store.request('pending-request')?.state, 'expired');
  } finally { await f.close(); }
});

test('fatal Telegram errors propagate, while malformed saved buttons do not jam delivery', async () => {
  const f = fixture();
  try {
    f.store.outgoing('fatal'); const id = f.store.pendingOutput()!.id;
    for (const code of [401, 403, 409]) {
      f.messenger.send = async () => { throw new TelegramError(code, 'fatal'); };
      await assert.rejects(() => flushOne(f.store, f.messenger, 123), error => error instanceof TelegramError && error.code === code);
    }
    assert.equal(f.store.pendingOutput()?.attempts, 0);
    f.store.db.prepare('UPDATE outbox SET buttons=? WHERE id=?').run('{broken', id);
    assert.equal(await flushOne(f.store, f.messenger, 123), true);
    assert.equal(f.store.pendingOutput(), undefined);
  } finally { await f.close(); }
});

test('failure recording a successful send is surfaced as a storage failure', async t => {
  const f = fixture();
  try {
    f.store.outgoing('delivered');
    t.mock.method(f.store, 'markOutputSent', () => { throw new Error('database full'); });
    await assert.rejects(() => flushOne(f.store, f.messenger, 123), /database full/);
    assert.equal(f.messenger.sent.length, 1); assert.equal(f.store.pendingOutput()?.attempts, 0);
  } finally { await f.close(); }
});

test('blank messages, broken surrogate pairs and truncated captions are valid Telegram text', async () => {
  const bodies: (string | FormData)[] = [];
  const telegram = new Telegram('token', (async (_url, options) => {
    bodies.push(options!.body as string | FormData);
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof fetch);
  await telegram.send(123, ' \n\t'); await telegram.edit(123, 1, '');
  await telegram.send(123, '\uD800hello\uDC00 🌍');
  await telegram.send(123, 'x'.repeat(699) + '🌍' + 'x'.repeat(4000));
  assert.equal(JSON.parse(bodies[0] as string).text, '(Пустой ответ)');
  assert.equal(JSON.parse(bodies[1] as string).text, '(Пустой ответ)');
  assert.equal(JSON.parse(bodies[2] as string).text, '\uFFFDhello\uFFFD 🌍');
  const caption = (bodies[3] as FormData).get('caption') as string;
  assert.equal(caption, 'x'.repeat(699) + '\n\nПолный ответ — в файле.');
});

test('one Telegram 429 enforces cooldown for output, progress, callbacks and polling', async t => {
  let now = 1000, calls = 0;
  t.mock.method(Date, 'now', () => now);
  const telegram = new Telegram('token', (async () => {
    if (++calls === 1) return Response.json({ ok: false, error_code: 429, description: 'slow down', parameters: { retry_after: 4 } });
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof fetch);
  await assert.rejects(() => telegram.send(123, 'first'), error => error instanceof TelegramError && error.retryAfter === 4);
  now = 2500;
  for (const attempt of [() => telegram.send(123, 'next'), () => telegram.edit(123, 1, 'progress'), () => telegram.answerCallback('cb'), () => telegram.call('getUpdates')]) {
    await assert.rejects(attempt, error => error instanceof TelegramError && error.code === 429 && error.retryAfter === 3);
  }
  assert.equal(calls, 1);
  now = 5000; await telegram.edit(123, 1, 'progress'); assert.equal(calls, 2);
});

test('shutdown cancels requests even while Telegram cooldown is active', async () => {
  const shutdown = new AbortController(); let calls = 0;
  const telegram = new Telegram('token', (async () => {
    calls++; return Response.json({ ok: false, error_code: 429, description: 'rate', parameters: { retry_after: 60 } });
  }) as typeof fetch, shutdown.signal);
  await assert.rejects(() => telegram.send(123, 'first'), TelegramError);
  shutdown.abort();
  await assert.rejects(() => telegram.send(123, 'second'), error => !(error instanceof TelegramError));
  assert.equal(calls, 1);
});

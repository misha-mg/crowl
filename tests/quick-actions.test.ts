import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fixture, message, route, until } from './helpers.ts';
import { Telegram, QUICK_ACTIONS, INFO_ACTION, STOP_ACTION } from '../src/telegram.ts';
import { formatMetrics, gitBranch } from '../src/metrics.ts';
import { Store } from '../src/storage.ts';

test('plain responses attach three persistent quick buttons; inline menus remain intact', async () => {
  const requests: any[] = [];
  const telegram = new Telegram('token', (async (_url, options) => {
    requests.push(JSON.parse(String(options?.body))); return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof fetch);
  await telegram.send(123, 'hello');
  assert.deepEqual(requests[0].reply_markup, QUICK_ACTIONS);
  assert.equal(QUICK_ACTIONS.keyboard.flat().length, 3);
  assert.equal(QUICK_ACTIONS.is_persistent, true); assert.equal(QUICK_ACTIONS.one_time_keyboard, false);
  const inline = { inline_keyboard: [[{ text: 'Claude', callback_data: 'choose' }]] };
  await telegram.send(123, 'choose', inline); assert.deepEqual(requests[1].reply_markup, inline);
});
test('stop quick button bypasses queue and cancels a pending permission', async () => {
  const f = fixture(() => ({ provider: 'codex', async run(options) { await options.callbacks.input({ kind: 'permission', title: 'Pending' }); return 'bad'; }, async close() {} }));
  try {
    f.store.set('chat', '123'); f.store.createSession('codex', 'ask'); route(f, message(1, 'task')); f.engine.kick();
    await until(() => !!f.store.db.prepare("SELECT 1 FROM requests WHERE state='pending'").get());
    route(f, message(2, INFO_ACTION));
    await until(() => !!f.store.db.prepare("SELECT 1 FROM outbox WHERE text LIKE 'Проект:%'").get());
    assert.equal(f.store.db.prepare('SELECT state FROM requests').get()!.state, 'pending');
    route(f, message(3, STOP_ACTION)); await f.engine.settle();
    assert.equal(f.store.paused, true); assert.equal(f.store.db.prepare('SELECT state FROM jobs').get()!.state, 'interrupted');
    assert.equal(f.store.queue().length, 0);
  } finally { await f.close(); }
});
test('information button returns one summary, never a prompt, with observed per-session metrics', async () => {
  const f = fixture(() => ({ provider: 'codex', async run(options) {
    options.callbacks.metrics?.({ model: 'observed-model', inputTokens: 100, outputTokens: 20, contextTokens: 50, contextWindow: 1000, usageScope: 'session' }); return 'ok';
  }, async close() {} }));
  try {
    execFileSync('git', ['init', '--initial-branch=feature/quick-actions', f.dir], { stdio: 'pipe' });
    f.store.set('chat', '123'); const session = f.store.createSession('codex', 'full'); route(f, message(1, 'task')); f.engine.kick(); await f.engine.settle();
    const before = Number(f.store.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n);
    route(f, message(2, INFO_ACTION));
    await until(() => Number(f.store.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n) > before);
    assert.equal(Number(f.store.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n), before + 1);
    const text = String(f.store.db.prepare('SELECT text FROM outbox ORDER BY id DESC LIMIT 1').get()!.text);
    assert.ok(text.includes('feature/quick-actions')); assert.ok(text.includes('observed-model')); assert.ok(text.includes('100')); assert.ok(text.includes('5%'));
    assert.equal(Number(f.store.db.prepare('SELECT count(*) AS n FROM jobs').get()!.n), 1);
    const reopened = new Store(f.config);
    try { assert.equal(JSON.parse(reopened.get(`metrics:${session.id}`)!).model, 'observed-model'); } finally { reopened.close(); }
    f.store.createSession('claude', 'full'); const fresh = await f.engine.information();
    assert.ok(!fresh.includes('observed-model')); assert.ok(fresh.includes('нет данных от агента'));
  } finally { await f.close(); }
});
test('information works before selecting any agent and rejects other users', async () => {
  const f = fixture(); try {
    f.store.set('chat', '123'); route(f, message(1, INFO_ACTION));
    await until(() => !!f.store.pendingOutput()); assert.equal(f.store.sessions().length, 0); assert.equal(f.store.queue().length, 0);
    assert.ok(f.store.pendingOutput()?.text.includes('не выбран'));
    route(f, message(2, INFO_ACTION, 999)); assert.equal(Number(f.store.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n), 1);
  } finally { await f.close(); }
});
test('missing context is not represented as zero, and zero usage is a real value', () => {
  const missing = formatMetrics({}).join('\n'); assert.match(missing, /нет данных/); assert.ok(!missing.includes('0%'));
  const zero = formatMetrics({ inputTokens: 0, outputTokens: 0, contextWindow: 200000 }).join('\n');
  assert.match(zero, /вход 0/); assert.match(zero, /заполнение неизвестно/);
});
test('git information handles non-repositories and detached HEAD without changing files', async () => {
  const f = fixture(); try {
    assert.match(await gitBranch(f.dir), /не Git/);
    execFileSync('git', ['init', '--initial-branch=main', f.dir], { stdio: 'pipe' });
    execFileSync('git', ['-c', 'user.name=Crowl', '-c', 'user.email=crowl@localhost', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: f.dir, stdio: 'pipe' });
    execFileSync('git', ['checkout', '--detach'], { cwd: f.dir, stdio: 'pipe' });
    assert.match(await gitBranch(f.dir), /^detached HEAD · [a-f0-9]+$/);
  } finally { await f.close(); }
});

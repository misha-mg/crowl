import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, route, message, callback, until } from './helpers.ts';
import { OPTIONS_ACTION } from '../src/telegram.ts';

function option(f: ReturnType<typeof fixture>, id: number, action: string): void {
  route(f, callback(id, `option:${action}:${f.store.get('options_menu')}`));
}

test('options button opens one menu of eight actions, never an agent prompt', async () => {
  const f = fixture(); try {
    f.store.set('chat', '123'); route(f, message(1, OPTIONS_ACTION));
    const row = f.store.pendingOutput()!;
    assert.equal(row.text, 'Опции');
    const buttons = JSON.parse(row.buttons!).inline_keyboard.flat();
    assert.deepEqual(buttons.map((b: any) => b.text), ['Новая сессия', 'Закрыть сессию', 'Продолжить сессию', 'Переименовать', 'Чистый контекст', 'Разрешения', 'Очередь', 'Справка']);
    assert.ok(buttons.every((b: any) => Buffer.byteLength(b.callback_data) <= 64));
    assert.equal(f.store.queue().length, 0); assert.equal(f.store.sessions().length, 0);
    option(f, 2, 'new'); assert.ok(f.store.get('chooser'));
  } finally { await f.close(); }
});
test('new, clear, permissions and queue buttons use existing session controls', async () => {
  const f = fixture(); try {
    f.store.set('chat', '123'); const old = f.store.createSession('codex', 'full');
    route(f, message(1, '/options')); option(f, 2, 'new');
    route(f, callback(3, `new:claude:${f.store.get('chooser')}`)); assert.equal(f.store.session()?.provider, 'claude');
    route(f, message(4, OPTIONS_ACTION)); option(f, 5, 'permissions');
    assert.match(String(f.store.db.prepare('SELECT text FROM outbox ORDER BY id DESC LIMIT 1').get()!.text), /Запрошено: full/);
    option(f, 6, 'queue'); assert.ok(f.store.get('queue_menu'));
    const previous = f.store.session()!.id; option(f, 7, 'clear'); assert.notEqual(f.store.session()?.id, previous);
    assert.ok(f.store.session(old.id)); assert.equal(f.store.queue().length, 0);
  } finally { await f.close(); }
});
test('resume menu selects saved native context and clears an idle pause', async () => {
  const f = fixture(); try {
    f.store.set('chat', '123'); const old = f.store.createSession('codex', 'full');
    f.store.db.prepare('UPDATE sessions SET native_id=? WHERE id=?').run('saved-context', old.id);
    route(f, message(1, '/close')); f.store.paused = true;
    route(f, message(2, OPTIONS_ACTION)); option(f, 3, 'sessions');
    const menu = f.store.db.prepare('SELECT buttons FROM outbox ORDER BY id DESC LIMIT 1').get()!;
    assert.equal(JSON.parse(String(menu.buttons)).inline_keyboard[0][0].callback_data, `session:${old.id}`);
    route(f, callback(4, `session:${old.id}`)); assert.equal(f.store.paused, false);
    assert.equal(f.store.session()?.native_id, 'saved-context'); assert.equal(f.store.sessions().length, 1);
  } finally { await f.close(); }
});
test('rename button consumes the next name without sending it to the agent', async () => {
  const f = fixture(); try {
    f.store.set('chat', '123'); f.store.createSession('codex', 'full');
    route(f, message(1, OPTIONS_ACTION)); option(f, 2, 'rename');
    route(f, message(3, 'x'.repeat(81))); assert.ok(f.store.get('rename_session'));
    route(f, message(4, 'Авторизация')); assert.equal(f.store.session()?.name, 'Авторизация');
    assert.equal(f.store.get('rename_session'), ''); assert.equal(f.store.queue().length, 0);
    route(f, message(5, 'Actual task')); assert.equal(f.store.next()?.text, 'Actual task');
  } finally { await f.close(); }
});
test('rename cancellation is bound to its prompt; slash rename also ends name entry', async () => {
  const f = fixture(); try {
    f.store.set('chat', '123'); f.store.createSession('claude', 'full');
    route(f, message(1, OPTIONS_ACTION)); option(f, 2, 'rename'); const old = f.store.get('rename_prompt');
    option(f, 3, 'rename'); route(f, callback(4, `rename:cancel:${old}`)); assert.ok(f.store.get('rename_session'));
    route(f, callback(5, `rename:cancel:${f.store.get('rename_prompt')}`)); assert.equal(f.store.get('rename_session'), '');
    option(f, 6, 'rename'); route(f, message(7, '/rename New name')); assert.equal(f.store.get('rename_session'), '');
    assert.equal(f.store.session()?.name, 'New name');
  } finally { await f.close(); }
});
test('old options cannot close another session and unauthorized users cannot act', async () => {
  const f = fixture(); try {
    f.store.set('chat', '123'); f.store.createSession('codex', 'full');
    route(f, message(1, OPTIONS_ACTION)); const nonce = f.store.get('options_menu');
    route(f, message(2, '/clear')); const active = f.store.session()!.id;
    route(f, callback(3, `option:close:${nonce}`)); assert.equal(f.store.session()?.id, active);
    route(f, message(4, OPTIONS_ACTION));
    route(f, callback(5, `option:close:${f.store.get('options_menu')}`, 999)); assert.equal(f.store.session()?.id, active);
    option(f, 6, 'close'); assert.equal(f.store.session(), undefined); assert.ok(f.store.get('chooser'));
  } finally { await f.close(); }
});
test('options opens during execution; close from menu interrupts an approval', async () => {
  const f = fixture(() => ({ provider: 'codex', async run(options) { await options.callbacks.input({ kind: 'permission', title: 'Wait' }); return 'bad'; }, async close() {} }));
  try {
    f.store.set('chat', '123'); f.store.createSession('codex', 'ask'); route(f, message(1, 'task')); f.engine.kick();
    await until(() => !!f.store.db.prepare("SELECT 1 FROM requests WHERE state='pending'").get());
    route(f, message(2, OPTIONS_ACTION)); option(f, 3, 'close'); await f.engine.settle();
    assert.equal(f.engine.active, false); assert.equal(f.store.session(), undefined); assert.ok(f.store.get('chooser')); assert.equal(f.engine.fatal, undefined);
  } finally { await f.close(); }
});

import { join, basename } from 'node:path';
import { chmodSync, existsSync } from 'node:fs';
import { loadConfig, ensureData, DEFAULT_MAX_CONCURRENT_SESSIONS } from './config.ts';
import { Store } from './storage.ts';
import { Telegram, TelegramError, authorized, retryDelay } from './telegram.ts';
import type { Update } from './telegram.ts';
import { Engine } from './core.ts';
import { CodexAgent } from './providers/codex.ts';
import { ClaudeAgent } from './providers/claude.ts';
import { acquireLock, botLockPath, logger, rotateServiceLogs } from './service.ts';
import { capture, errorText, sleep } from './process.ts';
import { cleanupAudio } from './voice.ts';
import { flushOne } from './runtime.ts';
import { RuntimeLifecycle } from './lifecycle.ts';
import { runtimeIdentity } from './version.ts';

process.umask(0o077);
const lifecycle = new RuntimeLifecycle();
const shutdown = lifecycle.shutdown;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => lifecycle.requestStop());
const releases: (() => void)[] = [];
let store: Store | undefined, engine: Engine | undefined;
shutdown.signal.addEventListener('abort', () => { void engine?.stop().catch(() => {}); }, { once: true });
try {
  const config = loadConfig(); ensureData(config);
  rotateServiceLogs(config.data);
  if (existsSync(join(config.root, '.env'))) chmodSync(join(config.root, '.env'), 0o600);
  if (basename(config.root) !== '.crowl') throw new Error('Поместите Crowl в папку .crowl внутри рабочего проекта. См. README.md.');
  const log = logger(config.data);
  releases.push(acquireLock(join(config.data, 'instance-lock.sqlite')));
  const telegram = new Telegram(config.token, fetch, shutdown.signal);
  const me = await telegram.call('getMe', {}, shutdown.signal);
  releases.push(acquireLock(botLockPath(me.id)));
  const webhook = await telegram.call('getWebhookInfo', {}, shutdown.signal);
  if (webhook.url) throw new Error('У бота установлен webhook. Удалите его явно перед использованием polling Crowl.');
  store = new Store(config);
  for (const [key, value] of [['bot', String(me.id)], ['owner', String(config.owner)]]) {
    if (store.get(key) && store.get(key) !== value) throw new Error(`Привязка ${key} не совпадает с .data. Для нового бота/владельца используйте чистое состояние.`);
    store.set(key, value);
  }
  store.recover(); store.pruneTechnicalHistory(); cleanupAudio(config);
  engine = new Engine(config, store, telegram, provider => provider === 'codex' ? new CodexAgent(config.codex) : new ClaudeAgent(config.claude));
  for (const provider of ['codex', 'claude'] as const) {
    if (shutdown.signal.aborted) break;
    try { const version = await capture(config[provider], ['--version'], config.root, 8000, shutdown.signal); if (version.code === 0) engine.available.add(provider); }
    catch { log('provider.unavailable', { provider }); }
  }
  if (shutdown.signal.aborted) throw new Error('Запуск отменён.');
  if (!engine.available.size) throw new Error('Ни Codex, ни Claude не найдены. npm run doctor');
  await telegram.call('setMyCommands', { commands: [
    ['options', 'Меню действий'], ['new', 'Новая сессия'], ['close', 'Закрыть сессию и выбрать агента'], ['sessions', 'Сохранённые сессии'], ['rename', 'Переименовать сессию'], ['clear', 'Чистый контекст'],
    ['info', 'Проект, ветка, модель и usage'], ['status', 'Состояние'], ['permissions', 'Разрешения'], ['stop', 'Остановить'], ['queue', 'Очередь'], ['help', 'Справка'],
  ].map(([command, description]) => ({ command, description })) }, shutdown.signal);
  const identity = runtimeIdentity(config.root);
  const concurrency = config.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
  console.log(`Crowl ${identity.version} (${identity.revision}): @${me.username} → ${config.project}. Ctrl+C — остановка.`);
  if (concurrency > 1) console.warn(`Crowl: разрешено ${concurrency} одновременных сессий в общей папке. Для последовательных изменений задайте MAX_CONCURRENT_SESSIONS=1.`);
  log('runtime.started', { ...identity, providers: [...engine.available], maxConcurrentSessions: concurrency });
  const db = store, app = engine;
  const poll = async () => {
    while (!shutdown.signal.aborted) {
      let updates: Update[];
      const offset = db.pollingOffset();
      try {
        updates = await telegram.call<Update[]>('getUpdates', { offset, timeout: 25, limit: 100, allowed_updates: ['message', 'callback_query'] }, shutdown.signal);
      } catch (error) {
        if (shutdown.signal.aborted) break;
        if (error instanceof TelegramError && [401, 403, 409].includes(error.code)) throw error;
        log('telegram.poll_retry'); await retryDelay(error, shutdown.signal);
        continue;
      }
      // Persisting the inbox is not a network retry: storage errors must stop
      // the runtime before later updates can be acknowledged or work continues.
      if (!shutdown.signal.aborted) db.ingest(updates, update => authorized(update, config.owner, app.chat));
    }
  };
  const work = async () => {
    let nextMaintenance = Date.now() + 3_600_000;
    while (!shutdown.signal.aborted) {
      if (app.fatal) throw app.fatal;
      app.drainInbox(); app.kick(); void app.progress(); void app.typing();
      if (Date.now() >= nextMaintenance) { db.pruneTechnicalHistory(); nextMaintenance = Date.now() + 3_600_000; }
      await sleep(100, shutdown.signal);
    }
  };
  const output = async () => {
    while (!shutdown.signal.aborted) { const sent = await flushOne(db, telegram, app.chat); await sleep(sent ? 50 : 300, shutdown.signal); }
  };
  await lifecycle.supervise([poll, work, output]);
} catch (error) {
  process.exitCode = lifecycle.failure(error, failure => console.error(errorText(failure).replace(/\d+:[A-Za-z0-9_-]{20,}/g, '[TOKEN]')));
} finally {
  shutdown.abort();
  await engine?.stop().catch(() => {});
  try { store?.close(); } catch { /* preserve the original failure */ }
  for (const release of releases.reverse()) release();
}

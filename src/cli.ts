import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, ensureData, DEFAULT_MAX_CONCURRENT_SESSIONS } from './config.ts';
import { capture, errorText } from './process.ts';
import { manageService, plist } from './service.ts';
import type { ServiceAction } from './service.ts';
import { setupVoice } from './voice-setup.ts';
import { voiceReadiness } from './voice.ts';
import { backupState } from './storage.ts';
import { runtimeIdentity } from './version.ts';

function outboxOperation(data: string, action: string, selector?: string): void {
  const source = join(data, 'crowl.sqlite');
  if (!existsSync(source)) throw new Error('Состояние Crowl ещё не создано.');
  const db = new DatabaseSync(source, { readOnly: action === 'outbox-status' });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const columns = db.prepare('PRAGMA table_info(outbox)').all().map(row => row.name);
    if (!columns.includes('failed_at')) throw new Error('Эта схема ещё не поддерживает диагностику доставки. Запустите актуальную версию Crowl после backup.');
    if (action === 'outbox-status') {
      const counts = db.prepare('SELECT count(*) AS pending, sum(failed_at IS NOT NULL) AS failed FROM outbox WHERE sent=0').get()!;
      console.log(`Ожидают доставки: ${Number(counts.pending) - Number(counts.failed ?? 0)}. Не доставлены: ${Number(counts.failed ?? 0)}.`);
      for (const row of db.prepare('SELECT id,attempts,next_at,failed_at,last_error FROM outbox WHERE sent=0 ORDER BY id LIMIT 100').all()) {
        const error = String(row.last_error ?? '').replace(/\d+:[A-Za-z0-9_-]{20,}/g, '[TOKEN]').replace(/[\r\n]/g, ' ').slice(0, 300);
        console.log(`${row.id}: ${row.failed_at === null ? 'ожидает' : 'не доставлено'} · попыток ${row.attempts}${error ? ` · ${error}` : ''}`);
      }
      return;
    }
    if (selector !== 'all' && (!selector || !/^[1-9]\d*$/.test(selector) || !Number.isSafeInteger(Number(selector)))) throw new Error('Использование: npm run outbox:retry -- <ID|all>');
    const result = db.prepare(`UPDATE outbox SET failed_at=NULL,last_error=NULL,attempts=0,next_at=0${columns.includes('failure_count') ? ',failure_count=0' : ''}
      WHERE sent=0 AND failed_at IS NOT NULL ${selector === 'all' ? '' : 'AND id=?'}
      AND (request_id IS NULL OR EXISTS(SELECT 1 FROM requests WHERE requests.id=outbox.request_id AND requests.state='pending'))`).run(...(selector === 'all' ? [] : [Number(selector)]));
    console.log(`Возвращено в доставку: ${result.changes}. Задачи агентов не повторяются; закрытые запросы разрешений не отправляются.`);
  } finally { db.close(); }
}

process.umask(0o077);
const action = process.argv[2];
try {
  const config = loadConfig(undefined, false);
  if (action === 'version') {
    const identity = runtimeIdentity(config.root);
    console.log(`Crowl ${identity.version} (${identity.revision})\nИсходники: ${config.root}`);
  } else if (action === 'doctor') {
    const identity = runtimeIdentity(config.root);
    console.log(`Node ${process.version}\nCrowl ${identity.version} (${identity.revision})\nCrowl: ${config.root}\nПроект: ${config.project}`);
    try { loadConfig(); console.log('Telegram config: OK (token hidden)'); }
    catch { console.log('Telegram config: заполните .env перед запуском'); }
    for (const name of ['codex', 'claude', 'ffmpeg', 'whisper'] as const) {
      try {
        const result = await capture(config[name], name === 'ffmpeg' ? ['-version'] : name === 'whisper' ? ['--help'] : ['--version'], config.root);
        console.log(`${name}: ${result.code === 0 ? 'OK' : `exit ${result.code}`} · ${config[name]}`);
      } catch { console.log(`${name}: не найден · ${config[name]}`); }
    }
    const voice = voiceReadiness(config);
    console.log(`Голос: ${voice.ready ? 'компоненты найдены; проверьте живое аудио' : `не готов — ${voice.missing.join(', ')}. npm run voice:setup`}`);
    const concurrency = config.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
    console.log(`Одновременных сессий: ${concurrency}`);
    if (concurrency > 1) console.log('Параллельные сессии используют общие файлы проекта. Для последовательных изменений задайте MAX_CONCURRENT_SESSIONS=1.');
    console.log('Авторизация и фоновые permissions проверяются реальным запросом при приёмке; наличие CLI этого не доказывает.');
  } else if (action === 'service-print') console.log(plist(config));
  else if (['service-install', 'service-uninstall', 'service-status', 'service-start', 'service-stop', 'service-restart'].includes(action)) {
    if (['service-install', 'service-start', 'service-restart'].includes(action)) { loadConfig(); if (basename(config.root) !== '.crowl') throw new Error('Устанавливайте сервис из .crowl внутри рабочего проекта.'); ensureData(config); }
    console.log(await manageService(config, action.split('-')[1] as ServiceAction));
  } else if (action === 'exclude') {
    const result = await capture('git', ['rev-parse', '--git-path', 'info/exclude'], config.project);
    if (result.code !== 0) throw new Error('Родительский проект не является Git-репозиторием.');
    const { resolve } = await import('node:path'); const path = resolve(config.project, result.stdout.trim());
    const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (!before.split('\n').includes('/.crowl/')) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, before + '\n/.crowl/\n'); }
    console.log('Добавлено локальное исключение /.crowl/; общий .gitignore не изменён.');
  } else if (action === 'backup') {
    console.log(await backupState(config.data));
  } else if (action === 'outbox-status' || action === 'outbox-retry') {
    if (process.argv.length > (action === 'outbox-retry' ? 4 : 3)) throw new Error('Лишние аргументы команды доставки.');
    outboxOperation(config.data, action, process.argv[3]);
  } else if (action === 'voice-setup') {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try { await setupVoice(config, { signal: controller.signal, log: console.log }); }
    finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  } else throw new Error('Команды: version, doctor, voice-setup, service-install/start/stop/restart/uninstall/status/print, exclude, backup, outbox-status, outbox-retry <ID|all>');
} catch (error) { console.error(errorText(error).replace(/\d+:[A-Za-z0-9_-]{20,}/g, '[TOKEN]')); process.exitCode = 1; }

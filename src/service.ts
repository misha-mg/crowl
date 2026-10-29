import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, appendFileSync, renameSync, statSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename, isAbsolute } from 'node:path';
import type { Config } from './config.ts';
import { standardPath } from './config.ts';
import { capture, sleep } from './process.ts';

export const identity = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

// A held SQLite transaction is an OS-backed process lock. The OS releases it
// after a crash; no PID reuse, stale files, or killing an unrelated process.
export function acquireLock(file: string): () => void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  try { db.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS singleton(id INTEGER); BEGIN IMMEDIATE;'); }
  catch { db.close(); throw new Error('Другой экземпляр Crowl уже использует этот проект или токен бота.'); }
  return () => { db.close(); };
}
export function botLockPath(botId: number, base = join(homedir(), 'Library/Caches/crowl/locks')): string { return join(base, `bot-${botId}.sqlite`); }
export function serviceLabel(config: Pick<Config, 'root'>): string { return `dev.crowl.${identity(config.root)}`; }
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export function plist(config: Config, node = process.execPath): string {
  const path = [...new Set([dirname(node), dirname(config.claude), dirname(config.codex), ...standardPath.split(':'), ...(process.env.PATH ?? '').split(':')])].filter(p => p.startsWith('/')).join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(serviceLabel(config))}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(join(config.root, 'src/main.ts'))}</string></array>
<key>WorkingDirectory</key><string>${xml(config.root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>Umask</key><integer>63</integer>
<key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>15</integer>
<key>StandardOutPath</key><string>${xml(join(config.data, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(config.data, 'service-error.log'))}</string>
</dict></plist>\n`;
}
export type ServiceAction = 'install' | 'start' | 'stop' | 'restart' | 'uninstall' | 'status';
export interface ServiceOptions {
  home?: string; uid?: number; platform?: NodeJS.Platform; node?: string;
  runner?: typeof capture; pollMs?: number; stopWaitMs?: number;
}
export function servicePaths(config: Pick<Config, 'root'>, options: ServiceOptions = {}) {
  const home = options.home ?? homedir();
  const label = serviceLabel(config), domain = `gui/${options.uid ?? process.getuid!()}`;
  return { label, domain, target: `${domain}/${label}`, file: join(home, 'Library/LaunchAgents', label + '.plist'), locks: join(home, 'Library/Caches/crowl/locks') };
}
export interface ServiceState { installed: boolean; loaded: boolean; running: boolean; pid?: number; lastExitCode?: number; issue?: string }
const serviceError = (config: Config, value: string) => value.replaceAll(config.token || '\0', '[TOKEN]').replace(/\d+:[A-Za-z0-9_-]{20,}/g, '[TOKEN]').trim().slice(0, 600);
export async function serviceState(config: Config, options: ServiceOptions = {}): Promise<ServiceState> {
  const paths = servicePaths(config, options), run = options.runner ?? capture;
  const base = { installed: existsSync(paths.file), loaded: false, running: false };
  try {
    const result = await run('/bin/launchctl', ['print', paths.target], config.root, 5000);
    if (result.code !== 0) {
      // 113 is launchctl's service-not-found status. Other failures must not be
      // treated as proof that it is safe to bootstrap a competing process.
      return result.code === 113 ? base : { ...base, issue: serviceError(config, result.stderr || result.stdout || `launchctl exit ${result.code}`) };
    }
    const pid = result.stdout.match(/^\s*pid = (\d+)/m)?.[1];
    const state = result.stdout.match(/^\s*state = ([^\n]+)/m)?.[1].trim();
    const lastExit = result.stdout.match(/^\s*last exit code = (-?\d+)/m)?.[1];
    return { installed: base.installed, loaded: true, running: state === 'running' && !!pid, pid: pid ? Number(pid) : undefined, lastExitCode: lastExit ? Number(lastExit) : undefined };
  } catch { return { ...base, issue: 'Не удалось запросить launchctl.' }; }
}
function assertConfigured(config: Config, node: string): void {
  if (basename(config.root) !== '.crowl') throw new Error('Устанавливайте сервис из .crowl внутри рабочего проекта.');
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(config.token) || !Number.isSafeInteger(config.owner) || config.owner <= 0) throw new Error('Перед запуском сервиса заполните Telegram-токен и ID владельца в .env.');
  if (!isAbsolute(node)) throw new Error('Для сервиса нужен абсолютный путь Node.js.');
  accessSync(node, constants.X_OK); accessSync(join(config.root, 'src/main.ts'), constants.R_OK);
  accessSync(join(config.root, '.env'), constants.R_OK);
}
function assertNoOtherInstance(config: Config, options: ServiceOptions): void {
  const releases: (() => void)[] = [];
  try {
    releases.push(acquireLock(join(config.data, 'instance-lock.sqlite')));
    // The first component of a BotFather token is the bot ID. Runtime checks
    // getMe as well; this preflight only avoids starting duplicate pollers.
    releases.push(acquireLock(botLockPath(Number(config.token.split(':')[0]), servicePaths(config, options).locks)));
  } catch { throw new Error('Crowl уже работает в Terminal или другой копии с этим ботом. Остановите тот процесс через Ctrl+C; сервис не запускает второй poller.'); }
  finally { for (const release of releases.reverse()) release(); }
}
export function rotateServiceLogs(data: string): void {
  for (const log of ['service.log', 'service-error.log']) {
    const path = join(data, log);
    if (existsSync(path) && statSync(path).size > 2_000_000) {
      // launchd owns an open descriptor: copy+truncate keeps its descriptor
      // attached to the active log, unlike renaming the file at runtime.
      copyFileSync(path, path + '.1'); chmodSync(path + '.1', 0o600);
      writeFileSync(path, '', { mode: 0o600 });
    }
  }
}
async function reportStarted(config: Config, options: ServiceOptions): Promise<string> {
  const deadline = Date.now() + (options.pollMs ?? 2000);
  do {
    const state = await serviceState(config, options);
    if (state.running) return `Сервис запущен (PID ${state.pid}). Terminal можно закрыть. Автозапуск после login пользователя. Проверьте ответ бота в Telegram.`;
    if (Date.now() >= deadline) break;
    await sleep(100);
  } while (true);
  return `Сервис загружен, но работающий процесс ещё не подтверждён. Проверьте npm run service:status и ${config.data}/service-error.log.`;
}
export async function manageService(config: Config, action: ServiceAction, options: ServiceOptions = {}): Promise<string> {
  if ((options.platform ?? process.platform) !== 'darwin') throw new Error('Фоновый сервис поддерживается только на macOS.');
  const paths = servicePaths(config, options), run = options.runner ?? capture, node = options.node ?? process.execPath;
  let state = await serviceState(config, options);
  if (action === 'status') return [
    `Сервис: ${paths.label}`, `Установлен: ${state.installed ? 'да' : 'нет'}`,
    `Процесс: ${state.running ? `работает (PID ${state.pid})` : state.loaded ? 'загружен, не работает' : 'остановлен'}`,
    ...(state.lastExitCode === undefined ? [] : [`Последний exit code: ${state.lastExitCode}`]),
    ...(state.issue ? [`Диагностика: ${state.issue}`] : []),
    `Логи: ${config.data}/service.log и service-error.log`,
  ].join('\n');
  if (state.issue) throw new Error(`Не удалось проверить состояние сервиса: ${state.issue}`);
  const stop = async () => {
    if (!state.loaded) return;
    const result = await run('/bin/launchctl', ['bootout', paths.target], config.root, 12_000);
    if (result.code !== 0) throw new Error(`Не удалось остановить сервис: ${serviceError(config, result.stderr || result.stdout)}`);
    state = { ...state, loaded: false, running: false };
  };
  if (action === 'stop' || action === 'uninstall') {
    await stop();
    if (action === 'uninstall') { rmSync(paths.file, { force: true }); return 'Сервис удалён. .env и история сохранены.'; }
    return 'Сервис остановлен. Для запуска: npm run service:start.';
  }
  assertConfigured(config, node);
  const desired = plist(config, node);
  if (action === 'restart' && state.running && existsSync(paths.file) && readFileSync(paths.file, 'utf8') === desired) {
    // launchd owns this running process. Restart it in place so it waits for
    // process exit itself, without racing bootout against bootstrap.
    const result = await run('/bin/launchctl', ['kickstart', '-k', paths.target], config.root, 20_000);
    if (result.code !== 0) throw new Error(`launchctl kickstart: ${serviceError(config, result.stderr || result.stdout)}`);
    return reportStarted(config, options);
  }
  if (action === 'restart') {
    const wasLoaded = state.loaded;
    await stop();
    // bootout may return while the old process is still shutting down. Its
    // SQLite locks remain held until cleanup finishes or launchd terminates it.
    if (wasLoaded) {
      const deadline = Date.now() + (options.stopWaitMs ?? 20_000);
      while (true) {
        try { assertNoOtherInstance(config, options); break; }
        catch (error) {
          if (Date.now() >= deadline) throw error;
          await sleep(Math.min(100, deadline - Date.now()));
        }
      }
    }
  }
  if (state.loaded) {
    if (!existsSync(paths.file) || readFileSync(paths.file, 'utf8') !== desired) throw new Error('Пути или конфигурация сервиса изменились. Выполните npm run service:restart.');
    if (state.running) return `Сервис уже работает (PID ${state.pid}). Terminal можно закрыть.`;
    assertNoOtherInstance(config, options);
    const kicked = await run('/bin/launchctl', ['kickstart', paths.target], config.root, 5000);
    if (kicked.code !== 0) throw new Error(`launchctl kickstart: ${serviceError(config, kicked.stderr || kicked.stdout)}`);
  } else {
    assertNoOtherInstance(config, options);
    mkdirSync(dirname(paths.file), { recursive: true }); mkdirSync(config.data, { recursive: true, mode: 0o700 });
    chmodSync(config.data, 0o700); rotateServiceLogs(config.data);
    const previous = existsSync(paths.file) ? readFileSync(paths.file) : undefined;
    const temporary = paths.file + `.tmp-${process.pid}`;
    try { writeFileSync(temporary, desired, { mode: 0o600 }); renameSync(temporary, paths.file); }
    finally { rmSync(temporary, { force: true }); }
    let result = await run('/bin/launchctl', ['bootstrap', paths.domain, paths.file], config.root, 5000);
    // launchd can briefly reject registration with EIO after an unload. Check
    // registration before retrying: an ambiguous result must not create a rival.
    for (let retry = 0; result.code === 5 && retry < 3; retry++) {
      const current = await serviceState(config, options);
      if (current.issue) break;
      if (current.loaded) { result = { ...result, code: 0 }; break; }
      await sleep(200 * (retry + 1));
      assertNoOtherInstance(config, options);
      result = await run('/bin/launchctl', ['bootstrap', paths.domain, paths.file], config.root, 5000);
    }
    if (result.code !== 0) {
      if (previous) writeFileSync(paths.file, previous, { mode: 0o600 }); else rmSync(paths.file, { force: true });
      throw new Error(`launchctl bootstrap: ${serviceError(config, result.stderr || result.stdout)}`);
    }
  }
  // A successful bootstrap means loaded, not necessarily online. Report the
  // actual process state and never claim Telegram health solely from launchctl.
  return reportStarted(config, options);
}
export function logger(data: string): (type: string, details?: object) => void {
  const path = join(data, 'events.log');
  return (type, details = {}) => {
    try {
      if (existsSync(path) && statSync(path).size > 2_000_000) renameSync(path, path + '.1');
      appendFileSync(path, JSON.stringify({ time: new Date().toISOString(), type, ...details }) + '\n', { mode: 0o600 });
    } catch { console.error('Crowl: не удалось записать технический лог.'); }
  };
}

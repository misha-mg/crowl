import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, chmodSync } from 'node:fs';
import { dirname, join, resolve, delimiter, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';

export type Provider = 'codex' | 'claude';
export type PermissionMode = 'full' | 'ask';
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 1;
export interface Config {
  root: string; project: string; data: string; token: string; owner: number;
  provider: Provider; mode: PermissionMode; voice: boolean;
  codex: string; claude: string; whisper: string; ffmpeg: string; model: string;
  maxConcurrentSessions?: number;
}
export const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
export const standardPath = [join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter);

export function findBinary(name: string, override = ''): string {
  const candidates = override ? [override] : [...(process.env.PATH ?? '').split(delimiter), ...standardPath.split(delimiter)].map(p => join(p, name));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return resolve(candidate); } catch { /* try next */ }
  }
  return override || name;
}
export function loadConfig(root = ROOT, requireTelegram = true): Config {
  root = realpathSync(root);
  const file = join(root, '.env');
  // Per-project .env wins over accidental inherited settings from another instance.
  const env = { ...process.env, ...(existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}) };
  for (const key of ['CLAUDE_BIN', 'CODEX_BIN', 'WHISPER_BIN', 'FFMPEG_BIN', 'WHISPER_MODEL_PATH']) {
    if (env[key] && !isAbsolute(env[key]!)) throw new Error(`${key}: нужен абсолютный путь.`);
  }
  const token = env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
  const owner = Number(env.TELEGRAM_USER_ID);
  if (requireTelegram && (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token) || !Number.isSafeInteger(owner) || owner <= 0)) {
    throw new Error('Заполните TELEGRAM_BOT_TOKEN и числовой TELEGRAM_USER_ID в .crowl/.env. См. .env.example.');
  }
  const provider = env.DEFAULT_PROVIDER || 'codex';
  const mode = env.DEFAULT_PERMISSION_MODE || 'full';
  if (provider !== 'codex' && provider !== 'claude') throw new Error('DEFAULT_PROVIDER: codex или claude');
  if (mode !== 'full' && mode !== 'ask') throw new Error('DEFAULT_PERMISSION_MODE: full или ask');
  if (env.VOICE_ENABLED && !['true', 'false'].includes(env.VOICE_ENABLED)) throw new Error('VOICE_ENABLED: true или false');
  const maxConcurrentSessions = Number(env.MAX_CONCURRENT_SESSIONS || DEFAULT_MAX_CONCURRENT_SESSIONS);
  if (!Number.isInteger(maxConcurrentSessions) || maxConcurrentSessions < 1 || maxConcurrentSessions > 16) throw new Error('MAX_CONCURRENT_SESSIONS: целое число от 1 до 16.');
  return {
    root, project: realpathSync(join(root, '..')), data: join(root, '.data'), token, owner,
    provider, mode, voice: env.VOICE_ENABLED !== 'false',
    maxConcurrentSessions,
    codex: findBinary('codex', env.CODEX_BIN), claude: findBinary('claude', env.CLAUDE_BIN),
    whisper: findBinary('whisper-cli', env.WHISPER_BIN), ffmpeg: findBinary('ffmpeg', env.FFMPEG_BIN),
    model: env.WHISPER_MODEL_PATH || join(homedir(), 'Library/Caches/crowl/ggml-base.bin'),
  };
}
export function ensureData(config: Pick<Config, 'data'>): void { mkdirSync(config.data, { recursive: true, mode: 0o700 }); chmodSync(config.data, 0o700); }

export function agentEnv(): NodeJS.ProcessEnv {
  // Agent tools inherit project credentials, but never Crowl's Telegram credentials.
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${process.env.PATH ?? ''}${delimiter}${standardPath}` };
  delete env.TELEGRAM_BOT_TOKEN; delete env.TELEGRAM_USER_ID;
  delete env.CLAUDECODE; // a standalone child, not an accidental nested interactive session
  return env;
}

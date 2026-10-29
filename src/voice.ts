import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import type { Config } from './config.ts';
import { findBinary } from './config.ts';
import type { Messenger, TelegramMessage } from './telegram.ts';
import { launch, terminate } from './process.ts';
import { Interrupted } from './providers/types.ts';

export const MAX_VOICE_SECONDS = 300;
export const MAX_VOICE_BYTES = 20_000_000;
export interface VoiceReadiness { ready: boolean; missing: string[]; ffmpeg: string; whisper: string; model: string }

function executable(binary: string): string | undefined {
  const path = isAbsolute(binary) ? binary : findBinary(binary);
  try { accessSync(path, constants.X_OK); if (statSync(path).isFile()) return path; } catch { /* unavailable */ }
}
export function voiceReadiness(config: Pick<Config, 'ffmpeg' | 'whisper' | 'model'>): VoiceReadiness {
  const ffmpeg = executable(config.ffmpeg), whisper = executable(config.whisper), missing: string[] = [];
  if (!ffmpeg) missing.push('FFmpeg');
  if (!whisper) missing.push('whisper.cpp (whisper-cli)');
  try { const file = statSync(config.model); if (!file.isFile() || file.size === 0) missing.push('модель Whisper'); }
  catch { missing.push('модель Whisper'); }
  return { ready: missing.length === 0, missing, ffmpeg: ffmpeg ?? config.ffmpeg, whisper: whisper ?? config.whisper, model: config.model };
}

// Separate sessions may transcribe concurrently. One lane per project prevents
// several Whisper processes from competing for memory and preserves call order.
const lanes = new Map<string, Promise<void>>();
async function inVoiceLane<T>(key: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  const previous = lanes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => gate);
  lanes.set(key, tail);
  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Interrupted());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    await Promise.race([previous, interrupted]);
    if (signal.aborted) throw new Interrupted();
    return await work();
  } finally {
    signal.removeEventListener('abort', abort); release();
    void tail.then(() => { if (lanes.get(key) === tail) lanes.delete(key); });
  }
}

async function command(binary: string, args: string[], cwd: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Interrupted();
  const child = launch(binary, args, cwd);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = async (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (error) { await terminate(child); reject(error); } else resolve();
    };
    const abort = () => { void finish(new Interrupted()); };
    const timer = setTimeout(() => { void finish(new Error(`Таймаут ${basename(binary)} (5 минут).`)); }, 300_000);
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.resume(); child.stderr.resume(); child.stdin.end();
    child.stdin.on('error', () => {});
    child.on('error', error => { void finish(error); }); child.on('close', code => { void finish(code === 0 ? undefined : new Error(`Ошибка ${basename(binary)}: exit ${code}. Проверьте npm run doctor.`)); });
    if (signal.aborted) abort();
  });
}
export function cleanupAudio(config: Pick<Config, 'data'>): void { rmSync(join(config.data, 'audio'), { recursive: true, force: true }); }
export async function transcribe(config: Config, telegram: Messenger, voice: NonNullable<TelegramMessage['voice']>, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Interrupted();
  if (!config.voice) throw new Error('Голос отключён: VOICE_ENABLED=false.');
  if (!Number.isFinite(voice.duration) || voice.duration < 0 || voice.duration > MAX_VOICE_SECONDS || (voice.file_size !== undefined && (!Number.isFinite(voice.file_size) || voice.file_size < 0 || voice.file_size > MAX_VOICE_BYTES))) throw new Error('Голосовое: максимум 5 минут и 20 MB.');
  if (typeof voice.file_id !== 'string' || !voice.file_id.trim()) throw new Error('Telegram не передал идентификатор голосового сообщения.');
  const ready = voiceReadiness(config);
  if (!ready.ready) throw new Error(`Голос не готов: отсутствует ${ready.missing.join(', ')}. Выполните npm run voice:setup в .crowl.`);
  return inVoiceLane(config.data, signal, async () => {
  const parent = join(config.data, 'audio'); mkdirSync(parent, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(parent, 'voice-'));
  try {
    const audio = await telegram.download(voice.file_id, MAX_VOICE_BYTES, signal);
    if (signal.aborted) throw new Interrupted();
    if (audio.byteLength > MAX_VOICE_BYTES) throw new Error('Голосовое превышает 20 MB.');
    const ogg = join(dir, 'input.ogg'), wav = join(dir, 'input.wav'), output = join(dir, 'transcript');
    writeFileSync(ogg, audio, { mode: 0o600 });
    await command(ready.ffmpeg, ['-nostdin', '-v', 'error', '-y', '-i', ogg, '-t', '300', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], dir, signal);
    await command(ready.whisper, ['-m', config.model, '-f', wav, '-l', 'auto', '-otxt', '-of', output, '-np', '-nf', '-sns'], dir, signal);
    if (statSync(output + '.txt').size > 64 * 1024) throw new Error('Результат распознавания слишком большой. Отправьте более короткое голосовое сообщение.');
    const text = readFileSync(output + '.txt', 'utf8').trim();
    if (!text) throw new Error('Whisper не распознал текст. Отправьте сообщение текстом.');
    return text;
  } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

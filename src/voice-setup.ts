import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import { findBinary } from './config.ts';
import { capture } from './process.ts';
import { launch, terminate } from './process.ts';
import { voiceReadiness } from './voice.ts';
import type { VoiceReadiness } from './voice.ts';

export const BASE_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
// Published by whisper.cpp/models/README.md; detects truncated/error responses.
export const BASE_MODEL_SHA1 = '465707469ff3a37a2b9b8d8f89f2f99de7299dac';
const MAX_MODEL_BYTES = 256 * 1024 * 1024;

async function fileHash(file: string): Promise<string> {
  const hash = createHash('sha1');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function setupCommand(binary: string, args: string[], cwd: string, timeoutMs = 8000, signal?: AbortSignal): ReturnType<typeof capture> {
  signal?.throwIfAborted();
  const child = launch(binary, args, cwd);
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', settled = false;
    const finish = async (error?: Error, code: number | null = null) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { await terminate(child); reject(error); }
      else resolve({ code, stdout, stderr });
    };
    const abort = () => { void finish(new Error('Подготовка голоса отменена.')); };
    const timer = setTimeout(() => { void finish(new Error(`Таймаут подготовки ${basename(binary)}.`)); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-200_000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20_000); });
    child.stdin.on('error', () => {}); child.stdin.end();
    child.once('error', error => { void finish(error); });
    child.once('close', code => { void finish(undefined, code); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
function validateModelHeader(file: string): void {
  const header = Buffer.alloc(4), descriptor = openSync(file, 'r');
  try {
    if (!statSync(file).isFile() || readSync(descriptor, header, 0, 4, 0) !== 4 || header.readUInt32LE() !== 0x67676d6c) throw new Error('Файл модели не является моделью whisper.cpp в формате GGML. Укажите корректный WHISPER_MODEL_PATH.');
  } finally { closeSync(descriptor); }
}

export interface ModelDownloadOptions { fetcher?: typeof fetch; signal?: AbortSignal; expectedSha1?: string; maxBytes?: number }
export async function downloadBaseModel(target: string, options: ModelDownloadOptions = {}): Promise<void> {
  const expected = options.expectedSha1 ?? BASE_MODEL_SHA1;
  const limit = options.maxBytes ?? MAX_MODEL_BYTES;
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000);
  signal.throwIfAborted();
  const response = await (options.fetcher ?? fetch)(BASE_MODEL_URL, { signal });
  if (!response.ok || !response.body) throw new Error(`Не удалось скачать модель Whisper: HTTP ${response.status}.`);
  const lengthHeader = response.headers.get('content-length');
  const length = lengthHeader === null ? undefined : Number(lengthHeader);
  if (length !== undefined && (!Number.isSafeInteger(length) || length <= 0 || length > limit)) { await response.body.cancel(); throw new Error('Некорректный размер загрузки модели Whisper.'); }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.download-${randomUUID()}`;
  let size = 0;
  const hash = createHash('sha1');
  const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    size += chunk.byteLength;
    if (size > limit) { callback(new Error('Модель Whisper превышает допустимый размер загрузки.')); return; }
    hash.update(chunk); callback(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(response.body as any), bounded, createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal });
    if (length !== undefined && length !== size) throw new Error('Загрузка модели Whisper оборвалась: размер не совпадает.');
    if (hash.digest('hex') !== expected) throw new Error('Контрольная сумма модели Whisper не совпадает. Существующая модель не изменена.');
    validateModelHeader(temp);
    signal.throwIfAborted();
    renameSync(temp, target);
  } finally { rmSync(temp, { force: true }); }
}

export interface VoiceSetupOptions {
  signal?: AbortSignal;
  log?: (message: string) => void;
  fetcher?: typeof fetch;
  run?: typeof capture;
}
export async function setupVoice(config: Config, options: VoiceSetupOptions = {}): Promise<VoiceReadiness> {
  const log = options.log ?? console.log;
  const run: typeof capture = options.run ?? ((binary, args, cwd, timeout) => setupCommand(binary, args, cwd, timeout, options.signal));
  const resolve = () => ({ ...config,
    ffmpeg: config.ffmpeg === 'ffmpeg' ? findBinary('ffmpeg') : config.ffmpeg,
    whisper: config.whisper === 'whisper-cli' ? findBinary('whisper-cli') : config.whisper,
  });
  options.signal?.throwIfAborted();
  let selected = resolve(), ready = voiceReadiness(selected);
  const formulas = [];
  if (ready.missing.includes('FFmpeg')) formulas.push('ffmpeg');
  if (ready.missing.includes('whisper.cpp (whisper-cli)')) formulas.push('whisper-cpp');
  if (formulas.length) {
    if ((ready.missing.includes('FFmpeg') && isAbsolute(config.ffmpeg)) || (ready.missing.includes('whisper.cpp (whisper-cli)') && isAbsolute(config.whisper))) throw new Error('Путь FFMPEG_BIN или WHISPER_BIN недоступен. Исправьте путь в .env перед установкой.');
    const brew = findBinary('brew');
    const check = await run(brew, ['--version'], config.root).catch(() => undefined);
    if (!check || check.code !== 0) throw new Error('Установите Homebrew с https://brew.sh, затем повторите npm run voice:setup.');
    log(`Устанавливаю отсутствующие компоненты: ${formulas.join(', ')}.`);
    options.signal?.throwIfAborted();
    const install = await run(brew, ['install', ...formulas], config.root, 300_000);
    if (install.code !== 0) throw new Error('Homebrew не установил голосовые компоненты. Проверьте brew install ffmpeg whisper-cpp в Terminal.');
    selected = resolve(); ready = voiceReadiness(selected);
    if (ready.missing.some(value => value !== 'модель Whisper')) throw new Error('Компоненты после установки не найдены. Укажите FFMPEG_BIN и WHISPER_BIN в .env.');
  }
  // A private video-only FFmpeg (for example a browser test distribution) can
  // exist and execute but cannot decode Telegram's OGG/Opus voice messages.
  for (const [args, pattern, capability] of [
    [['-hide_banner', '-decoders'], /\bopus\b/, 'декодирование Opus'],
    [['-hide_banner', '-encoders'], /\bpcm_s16le\b/, 'кодирование PCM'],
    [['-hide_banner', '-formats'], /\bogg\b[\s\S]*\bwav\b|\bwav\b[\s\S]*\bogg\b/, 'форматы OGG и WAV'],
  ] as const) {
    options.signal?.throwIfAborted();
    const result = await run(selected.ffmpeg, [...args], config.root);
    if (result.code !== 0 || !pattern.test(result.stdout + result.stderr)) throw new Error(`FFmpeg не поддерживает ${capability}. Установите полный FFmpeg и проверьте FFMPEG_BIN.`);
  }
  options.signal?.throwIfAborted();
  const whisper = await run(selected.whisper, ['--help'], config.root);
  if (whisper.code !== 0) throw new Error('whisper-cli не запускается. Проверьте WHISPER_BIN.');
  mkdirSync(dirname(config.model), { recursive: true, mode: 0o700 });
  const lock = new DatabaseSync(`${config.model}.setup-lock.sqlite`);
  try {
    try { lock.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS singleton(id INTEGER); BEGIN IMMEDIATE;'); }
    catch { throw new Error('Подготовка этой модели уже запущена в другом экземпляре Crowl. Дождитесь завершения.'); }
    if (existsSync(config.model)) {
      validateModelHeader(config.model);
      if (basename(config.model) === 'ggml-base.bin' && await fileHash(config.model) !== BASE_MODEL_SHA1) throw new Error('Существующая ggml-base.bin повреждена или отличается от базовой модели. Укажите другую модель через WHISPER_MODEL_PATH либо удалите повреждённый файл и повторите установку.');
      log('Использую существующую модель Whisper.');
    } else {
      log('Скачиваю многоязычную модель base (~142 MiB).');
      await downloadBaseModel(config.model, { fetcher: options.fetcher, signal: options.signal });
    }
  } finally { lock.close(); }
  options.signal?.throwIfAborted();
  ready = voiceReadiness(selected);
  if (!ready.ready) throw new Error(`Голос не готов: ${ready.missing.join(', ')}.`);
  log(`Голосовые компоненты подготовлены. Модель: ${config.model}`);
  return ready;
}

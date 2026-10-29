import { errorText, sleep } from './process.ts';

export interface TelegramMessage { message_id: number; from?: { id: number }; chat: { id: number; type: string }; text?: string; voice?: { file_id: string; duration: number; file_size?: number }; reply_to_message?: { message_id: number } }
export interface Update { update_id: number; message?: TelegramMessage; callback_query?: { id: string; from: { id: number }; data?: string; message?: TelegramMessage } }
export type Buttons = { inline_keyboard: { text: string; callback_data: string }[][] };
export const STOP_ACTION = '⏹ Стоп';
export const INFO_ACTION = 'ℹ️ Информация';
export const OPTIONS_ACTION = '⚙️ Опции';
export const QUICK_ACTIONS = {
  keyboard: [[{ text: STOP_ACTION }, { text: INFO_ACTION }, { text: OPTIONS_ACTION }]],
  resize_keyboard: true, is_persistent: true, one_time_keyboard: false,
};
// Telegram rejects invalid UTF-16 or messages containing only whitespace. A
// progress slice can split an emoji even when the original model text is valid.
const wellFormed = (text: string): string => text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
export const messageText = (text: string): string => text.trim() ? wellFormed(text) : '(Пустой ответ)';
const captionText = (text: string): string => text.slice(0, 700).replace(/[\uD800-\uDBFF]$/, '');
export interface Messenger {
  send(chat: number, text: string, buttons?: Buttons | null): Promise<number>;
  typing(chat: number): Promise<void>;
  edit(chat: number, id: number, text: string): Promise<void>;
  delete(chat: number, id: number): Promise<void>;
  answerCallback(id: string, text?: string): Promise<void>;
  download(fileId: string, limit: number, signal?: AbortSignal): Promise<Uint8Array>;
}
export class TelegramError extends Error {
  code: number; retryAfter: number;
  constructor(code: number, description: string, retryAfter = 0) { super(description); this.code = code; this.retryAfter = retryAfter; }
}
export class Telegram implements Messenger {
  #base: string; #token: string; #fetch: typeof fetch; #shutdown?: AbortSignal;
  #retryUntil = 0;
  constructor(token: string, fetcher = fetch, shutdown?: AbortSignal) { this.#token = token; this.#base = `https://api.telegram.org/bot${token}/`; this.#fetch = fetcher; this.#shutdown = shutdown; }
  redact(text: string): string { return text.replaceAll(this.#token, '[TOKEN]').replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[TOKEN]'); }
  async call<T = any>(method: string, params: object = {}, signal?: AbortSignal, form?: FormData): Promise<T> {
    try {
      signal?.throwIfAborted(); this.#shutdown?.throwIfAborted();
      const remaining = this.#retryUntil - Date.now();
      if (remaining > 0) throw new TelegramError(429, 'Telegram: ожидается окончание ограничения частоты запросов.', Math.ceil(remaining / 1000));
      const response = await this.#fetch(this.#base + method, {
        method: 'POST', headers: form ? undefined : { 'content-type': 'application/json' },
        body: form ?? JSON.stringify(params), signal: AbortSignal.any([AbortSignal.timeout(40_000), ...[signal, this.#shutdown].filter((s): s is AbortSignal => !!s)]),
      });
      const body = await response.json() as any;
      if (!body.ok) {
        const code = body.error_code ?? response.status;
        const rawRetry = body.parameters?.retry_after;
        const retry = typeof rawRetry === 'number' && Number.isFinite(rawRetry) && rawRetry > 0 ? rawRetry : code === 429 ? 1 : 0;
        if (code === 429) this.#retryUntil = Math.max(this.#retryUntil, Date.now() + retry * 1000);
        throw new TelegramError(code, this.redact(body.description ?? 'Telegram error'), retry);
      }
      return body.result as T;
    } catch (error) { if (error instanceof TelegramError) throw error; throw new Error(this.redact(errorText(error))); }
  }
  async send(chat: number, text: string, buttons?: Buttons | null): Promise<number> {
    text = messageText(text);
    if (text.length <= 4000) {
      // Reply keyboards make a message uneditable. null intentionally omits
      // markup for progress; the chat's existing persistent keyboard stays put.
      const result = await this.call('sendMessage', { chat_id: chat, text, reply_markup: buttons === null ? undefined : buttons ?? QUICK_ACTIONS });
      return result.message_id;
    }
    // One durable output maps to one Telegram API request, avoiding partial chunk replay.
    const form = new FormData(); form.set('chat_id', String(chat));
    form.set('document', new Blob([text], { type: 'text/plain;charset=utf-8' }), 'crowl-response.txt');
    form.set('caption', captionText(text) + '\n\nПолный ответ — в файле.');
    if (buttons) form.set('reply_markup', JSON.stringify(buttons));
    return (await this.call('sendDocument', {}, undefined, form)).message_id;
  }
  async typing(chat: number): Promise<void> { await this.call('sendChatAction', { chat_id: chat, action: 'typing' }); }
  async edit(chat: number, id: number, text: string): Promise<void> { await this.call('editMessageText', { chat_id: chat, message_id: id, text: messageText(text) }); }
  async delete(chat: number, id: number): Promise<void> { await this.call('deleteMessage', { chat_id: chat, message_id: id }); }
  async answerCallback(id: string, text = ''): Promise<void> { await this.call('answerCallbackQuery', { callback_query_id: id, text }); }
  async download(fileId: string, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
    const info = await this.call('getFile', { file_id: fileId }, signal);
    if (info.file_size > limit || typeof info.file_path !== 'string' || !/^[A-Za-z0-9_/.-]+$/.test(info.file_path) || info.file_path.split('/').includes('..')) throw new Error('Некорректный или слишком большой аудиофайл.');
    let response: Response;
    try { response = await this.#fetch(`https://api.telegram.org/file/bot${this.#token}/${info.file_path}`, { signal: AbortSignal.any([AbortSignal.timeout(60_000), ...[signal, this.#shutdown].filter((s): s is AbortSignal => !!s)]) }); }
    catch (error) { throw new Error(this.redact(errorText(error))); }
    if (!response.ok || !response.body) throw new Error('Не удалось скачать аудио Telegram.');
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) throw new Error('Аудио превышает 20 MB.'); chunks.push(part.value); }
    } catch (error) { throw new Error(this.redact(errorText(error))); }
    finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks);
  }
}
export function authorized(update: Update, owner: number, chatId?: number): boolean {
  const callback = update.callback_query;
  const message = callback?.message ?? update.message;
  return !!message && (callback?.from.id ?? message.from?.id) === owner && message.chat.type === 'private'
    && (chatId === undefined || message.chat.id === chatId);
}
export async function retryDelay(error: unknown, signal?: AbortSignal): Promise<void> {
  await sleep(error instanceof TelegramError && error.retryAfter ? error.retryAfter * 1000 : 2000, signal);
}

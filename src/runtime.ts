import type { Store } from './storage.ts';
import type { Messenger, Buttons } from './telegram.ts';
import { TelegramError } from './telegram.ts';
import { errorText } from './process.ts';

export const MAX_DELIVERY_ATTEMPTS = 12;

const deliveryError = (error: unknown): string => errorText(error)
  .replace(/\d+:[A-Za-z0-9_-]{20,}/g, '[TOKEN]').slice(0, 1000);

export async function flushOne(store: Store, messenger: Messenger, chat: number | undefined, now = Date.now()): Promise<boolean> {
  if (chat === undefined) return false;
  const row = store.pendingOutput(); if (!row || row.next_at > now) return false;
  if (row.request_id && store.request(row.request_id)?.state !== 'pending') {
    store.markOutputSent(row.id); return true;
  }
  let id: number;
  try {
    if (row.edit_message_id && row.text.length <= 4000) {
      try { await messenger.edit(chat, row.edit_message_id, row.text); id = row.edit_message_id; }
      catch (error) {
        if (error instanceof TelegramError && error.code === 400 && /message is not modified/i.test(error.message)) id = row.edit_message_id;
        else if (error instanceof TelegramError && error.code === 400 && /message to edit not found|message can't be edited/i.test(error.message)) {
          id = await messenger.send(chat, row.text);
          await messenger.delete(chat, row.edit_message_id).catch(() => {});
        }
        else throw error;
      }
    } else {
      id = await messenger.send(chat, row.text, row.buttons ? JSON.parse(row.buttons) as Buttons : undefined);
      if (row.edit_message_id) await messenger.delete(chat, row.edit_message_id).catch(() => {});
    }
  } catch (error) {
    if (error instanceof TelegramError && [401, 403, 409].includes(error.code)) throw error;
    const throttled = error instanceof TelegramError && error.code === 429;
    const permanent = error instanceof SyntaxError || (error instanceof TelegramError && error.code >= 400 && error.code < 500 && ![408, 425, 429].includes(error.code));
    if (permanent || (!throttled && row.failure_count + 1 >= MAX_DELIVERY_ATTEMPTS)) {
      store.failOutput(row.id, deliveryError(error), now);
      return true;
    }
    const delay = error instanceof TelegramError && error.retryAfter ? error.retryAfter * 1000 : Math.min(60_000, 1000 * 2 ** Math.min(row.attempts, 6));
    store.deferOutput(row.id, deliveryError(error), now + delay, !throttled);
    return false;
  }
  // A storage failure must stop the worker, not be mistaken for a failed send.
  // Telegram may already have delivered the message; replay remains at-least-once.
  store.markOutputSent(row.id, id);
  return true;
}

/** Telegram update IDs may restart; message/callback identities remain stable. */
export function updateIdentity(update: unknown): string | undefined {
  if (!update || typeof update !== 'object') return;
  const { message, callback_query: callback } = update as {
    message?: { message_id?: unknown; chat?: { id?: unknown } }; callback_query?: { id?: unknown };
  };
  if (typeof callback?.id === 'string' && callback.id) return `callback:${callback.id}`;
  if (typeof message?.message_id === 'number' && Number.isSafeInteger(message.message_id)
      && typeof message.chat?.id === 'number' && Number.isSafeInteger(message.chat.id)) return `message:${message.chat.id}:${message.message_id}`;
}

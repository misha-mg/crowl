import { loadConfig } from '../src/config.ts';
import { Telegram } from '../src/telegram.ts';
import type { Update } from '../src/telegram.ts';
import { errorText } from '../src/process.ts';

try {
  const config = loadConfig(undefined, false);
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(config.token)) throw new Error('Сначала заполните TELEGRAM_BOT_TOKEN в .env.');
  const telegram = new Telegram(config.token);
  const webhook = await telegram.call('getWebhookInfo');
  if (webhook.url) throw new Error('У бота активен webhook. Используйте нового бота или отключите webhook явно.');
  // No offset: inspect pending updates without acknowledging or consuming them.
  const updates = await telegram.call<Update[]>('getUpdates', { timeout: 0, allowed_updates: ['message', 'callback_query'] });
  const users = new Map<number, string>();
  for (const update of updates) {
    const message = update.message;
    if (message?.chat.type === 'private' && message.from) users.set(message.from.id, String((message.from as { username?: string }).username ?? 'без username'));
  }
  if (!users.size) console.log('Откройте своего бота, отправьте /start и повторите команду. Crowl должен быть остановлен.');
  else for (const [id, name] of users) console.log(`${name}: TELEGRAM_USER_ID=${id}`);
} catch (error) { console.error(errorText(error).replace(/\d+:[A-Za-z0-9_-]{20,}/g, '[TOKEN]')); process.exitCode = 1; }

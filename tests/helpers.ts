import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.ts';
import { Store } from '../src/storage.ts';
import type { Messenger, Buttons, Update } from '../src/telegram.ts';
import { Engine } from '../src/core.ts';
import type { Agent, AgentRun } from '../src/providers/types.ts';

export class FakeMessenger implements Messenger {
  sent: { id: number; chat: number; text: string; buttons?: Buttons | null; replyToMessageId?: number }[] = [];
  callbacks: string[] = []; downloads = 0;
  typingCalls: number[] = [];
  edits: { id: number; text: string }[] = []; deleted: number[] = [];
  async send(chat: number, text: string, buttons?: Buttons | null, replyToMessageId?: number): Promise<number> { const id = this.sent.length + 1; this.sent.push({ id, chat, text, buttons, replyToMessageId }); return id; }
  async edit(_chat: number, id: number, text: string): Promise<void> { this.edits.push({ id, text }); }
  async delete(_chat: number, id: number): Promise<void> { this.deleted.push(id); }
  async answerCallback(id: string): Promise<void> { this.callbacks.push(id); }
  async typing(chat: number): Promise<void> { this.typingCalls.push(chat); }
  async download(): Promise<Uint8Array> { this.downloads++; return new Uint8Array(); }
}
export function fixture(factory?: () => Agent) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'crowl test '))), root = join(dir, '.crowl'); mkdirSync(root);
  const config: Config = { root, project: dir, data: join(root, '.data'), token: '123:abcdefghijklmnopqrstuvwxyz', owner: 123, provider: 'codex', mode: 'full', voice: true, codex: 'codex', claude: 'claude', whisper: 'missing', ffmpeg: 'missing', model: join(dir, 'missing-model') };
  // Concurrent behavior tests opt in; production configuration defaults to one.
  config.maxConcurrentSessions = 4;
  const store = new Store(config), messenger = new FakeMessenger(), prompts: AgentRun[] = [];
  const engine = new Engine(config, store, messenger, factory ?? (() => ({ provider: 'codex', async run(options) { prompts.push(options); options.callbacks.nativeId('native-1'); options.callbacks.applied('never / dangerFullAccess'); return 'Результат'; }, async close() {} })));
  engine.available = new Set(['codex', 'claude']);
  return { dir, config, store, engine, messenger, prompts, close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
export const message = (id: number, text: string, owner = 123, reply?: number): Update => ({ update_id: id, message: { message_id: id, from: { id: owner }, chat: { id: owner, type: 'private' }, text, reply_to_message: reply ? { message_id: reply } : undefined } });
export const callback = (id: number, data: string, owner = 123): Update => ({ update_id: id, callback_query: { id: String(id), from: { id: owner }, data, message: { message_id: 1, from: { id: 999 }, chat: { id: owner, type: 'private' } } } });
export function route(f: ReturnType<typeof fixture>, update: Update): void { f.store.ingest([update], () => true); f.engine.drainInbox(); }
export async function until(predicate: () => boolean, timeout = 3000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('Test condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

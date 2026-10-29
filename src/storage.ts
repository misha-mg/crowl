import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config, PermissionMode, Provider } from './config.ts';
import { ensureData } from './config.ts';
import { migrateStorage, SCHEMA_VERSION } from './migrations.ts';
import { assertTransition } from './job-state.ts';
import type { RunState } from './job-state.ts';
import { updateIdentity } from './inbox-identity.ts';
export type { RunState } from './job-state.ts';

// Probe before Telegram's 7-day reset, allowing for 24-hour retained updates and an in-flight poll.
export const IDLE_OFFSET_RESET_MS = 5 * 86_400_000;
export interface Session { id: string; provider: Provider; native_id: string | null; name: string; mode: PermissionMode; applied: string | null; created: number }
export interface Job { id: string; session_id: string; update_id: number; text: string | null; voice: string | null; state: RunState; result: string | null; created: number; origin_message_id: number | null }
export interface InputRequest { id: string; job_id: string; kind: 'permission' | 'question'; body: string; message_id: number | null; state: string; created: number }
export interface Outgoing { id: number; text: string; buttons: string | null; request_id: string | null; edit_message_id: number | null; reply_to_message_id: number | null; attempts: number; failure_count: number; next_at: number; failed_at: number | null; last_error: string | null; created: number }

export class Store {
  readonly db: DatabaseSync;
  constructor(config: Pick<Config, 'data' | 'project'>) {
    ensureData(config);
    this.db = new DatabaseSync(join(config.data, 'crowl.sqlite'));
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get()) {
      const previous = this.get('project');
      if (previous && previous !== config.project) { this.db.close(); throw new Error('Состояние .data принадлежит другому пути проекта. Переносите код без .data или восстановите прежний путь.'); }
    }
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version > SCHEMA_VERSION) { this.db.close(); throw new Error('БД создана более новой версией Crowl. Обновите код.'); }
    chmodSync(join(config.data, 'crowl.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`);
    try { migrateStorage(this.db, config.data, version); } catch (error) { this.db.close(); throw error; }
    const previous = this.get('project');
    if (previous && previous !== config.project) { this.db.close(); throw new Error('Состояние .data принадлежит другому пути проекта. Переносите код без .data или восстановите прежний путь.'); }
    this.set('project', config.project);
  }
  tx<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* preserve original failure */ } throw error; }
  }
  get(key: string): string | undefined { return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value; }
  set(key: string, value: string): void { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  pausedFor(sessionId: string): boolean { return this.get(`paused:${sessionId}`) === 'true'; }
  setPaused(sessionId: string, value: boolean): void { this.set(`paused:${sessionId}`, String(value)); }
  get paused(): boolean { const id = this.get('active_session'); return id ? this.pausedFor(id) : this.get('paused') === 'true'; }
  set paused(value: boolean) { const id = this.get('active_session'); if (id) this.setPaused(id, value); else this.set('paused', String(value)); }
  session(id = this.get('active_session')): Session | undefined { return id ? this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as unknown as Session | undefined : undefined; }
  createSession(provider: Provider, mode: PermissionMode): Session {
    const id = randomUUID().slice(0, 12);
    this.db.prepare('INSERT INTO sessions VALUES (?,?,NULL,?,?,NULL,?)').run(id, provider, `${provider} · ${new Date().toLocaleString('ru-RU')}`, mode, Date.now());
    this.set('active_session', id); return this.session(id)!;
  }
  sessions(page = 0): Session[] { return this.db.prepare('SELECT * FROM sessions ORDER BY created DESC, rowid DESC LIMIT 8 OFFSET ?').all(page * 8) as unknown as Session[]; }
  busy(sessionId?: string): boolean { return !!this.db.prepare(`SELECT 1 FROM jobs WHERE state IN ('queued','preparing','running','waiting_input')${sessionId ? ' AND session_id=?' : ''} LIMIT 1`).get(...(sessionId ? [sessionId] : [])); }
  enqueue(updateId: number, session: Session, text: string | null, voice: object | null, originMessageId?: number): Job {
    if (Number((this.db.prepare("SELECT count(*) AS n FROM jobs WHERE state='queued' AND session_id=?").get(session.id) as { n: number }).n) >= 20) throw new Error('Очередь заполнена (20). Дождитесь выполнения или очистите /queue.');
    const id = randomUUID().slice(0, 12);
    this.db.prepare("INSERT INTO jobs(id,session_id,update_id,text,voice,state,result,created,origin_message_id) VALUES (?,?,?,?,?,'queued',NULL,?,?)").run(id, session.id, updateId, text, voice ? JSON.stringify(voice) : null, Date.now(), originMessageId ?? null);
    if (originMessageId) this.bindMessage(originMessageId, session.id);
    return this.job(id)!;
  }
  job(id: string): Job | undefined { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as unknown as Job | undefined; }
  bindMessage(messageId: number, sessionId: string): void { this.db.prepare('INSERT OR IGNORE INTO message_sessions VALUES (?,?)').run(messageId, sessionId); }
  sessionForMessage(messageId: number): string | undefined {
    return (this.db.prepare('SELECT session_id FROM message_sessions WHERE message_id=?').get(messageId) as {session_id: string} | undefined)?.session_id
      ?? (this.db.prepare('SELECT session_id FROM jobs WHERE origin_message_id=? ORDER BY rowid DESC LIMIT 1').get(messageId) as {session_id: string} | undefined)?.session_id;
  }
  queue(sessionId?: string): Job[] { return this.db.prepare(`SELECT * FROM jobs WHERE state='queued'${sessionId ? ' AND session_id=?' : ''} ORDER BY created,rowid`).all(...(sessionId ? [sessionId] : [])) as unknown as Job[]; }
  next(sessionId?: string): Job | undefined { return this.queue(sessionId)[0]; }
  state(id: string, state: RunState, result: string | null = null): void {
    const job = this.job(id); if (!job) throw new Error('Задача отсутствует.');
    assertTransition(job.state, state);
    this.db.prepare('UPDATE jobs SET state=?,result=COALESCE(?,result) WHERE id=?').run(state, result, id);
  }
  renameSession(id: string, name: string): void { this.db.prepare('UPDATE sessions SET name=? WHERE id=?').run(name, id); }
  setSessionMode(id: string, mode: PermissionMode): void { this.db.prepare('UPDATE sessions SET mode=?,applied=NULL WHERE id=?').run(mode, id); }
  setNativeSessionId(id: string, nativeId: string): void { this.db.prepare('UPDATE sessions SET native_id=? WHERE id=?').run(nativeId, id); }
  setApplied(id: string, description: string): void { this.db.prepare('UPDATE sessions SET applied=? WHERE id=?').run(description, id); }
  setJobText(id: string, text: string): void { this.db.prepare('UPDATE jobs SET text=? WHERE id=?').run(text, id); }
  cancelQueued(sessionId: string, reason: string): void { this.db.prepare("UPDATE jobs SET state='interrupted',result=? WHERE state='queued' AND session_id=?").run(reason, sessionId); }
  pendingRequestForMessage(messageId: number): InputRequest | undefined { return this.db.prepare("SELECT * FROM requests WHERE message_id=? AND state='pending'").get(messageId) as unknown as InputRequest | undefined; }
  requestForMessage(messageId: number): InputRequest | undefined { return this.db.prepare('SELECT * FROM requests WHERE message_id=?').get(messageId) as unknown as InputRequest | undefined; }
  answerRequest(id: string): void { this.db.prepare("UPDATE requests SET state='answered' WHERE id=? AND state='pending'").run(id); }
  expireRequest(id: string): void { this.db.prepare("UPDATE requests SET state='expired' WHERE id=? AND state='pending'").run(id); }
  createInputRequest(id: string, jobId: string, kind: InputRequest['kind'], body: string): void { this.db.prepare("INSERT INTO requests VALUES (?,?,?,?,NULL,'pending',?)").run(id, jobId, kind, body, Date.now()); }
  event(job: string, type: string, body: unknown): void { this.db.prepare('INSERT INTO events(job_id,type,body,created) VALUES (?,?,?,?)').run(job, type, JSON.stringify(body), Date.now()); }
  outgoing(text: string, buttons?: unknown, requestId?: string, editMessageId?: number, replyToMessageId?: number): void { this.db.prepare('INSERT INTO outbox(text,buttons,request_id,edit_message_id,reply_to_message_id,created) VALUES (?,?,?,?,?,?)').run(text, buttons ? JSON.stringify(buttons) : null, requestId ?? null, editMessageId ?? null, replyToMessageId ?? null, Date.now()); }
  pendingOutput(): Outgoing | undefined { return this.db.prepare('SELECT * FROM outbox WHERE sent=0 AND failed_at IS NULL ORDER BY id LIMIT 1').get() as unknown as Outgoing | undefined; }
  markOutputSent(id: number, messageId?: number): void {
    this.tx(() => {
      const row = this.db.prepare('SELECT * FROM outbox WHERE id=?').get(id) as unknown as Outgoing | undefined;
      if (!row) throw new Error('Исходящее сообщение отсутствует.');
      this.db.prepare('UPDATE outbox SET sent=1,last_error=NULL WHERE id=?').run(id);
      if (messageId !== undefined) {
        const session = row.reply_to_message_id ? this.sessionForMessage(row.reply_to_message_id) : undefined;
        if (session) this.bindMessage(messageId, session);
        if (row.request_id) this.db.prepare('UPDATE requests SET message_id=? WHERE id=?').run(messageId, row.request_id);
      }
    });
  }
  failOutput(id: number, error: string, now: number): void {
    this.tx(() => {
      this.db.prepare('UPDATE outbox SET failed_at=?,last_error=?,attempts=attempts+1,failure_count=failure_count+1 WHERE id=?').run(now, error.slice(0, 1000), id);
      this.db.prepare("UPDATE requests SET state='expired' WHERE state='pending' AND id=(SELECT request_id FROM outbox WHERE id=?)").run(id);
    });
  }
  deferOutput(id: number, error: string, nextAt: number, countFailure = true): void {
    this.db.prepare('UPDATE outbox SET attempts=attempts+1,failure_count=failure_count+?,last_error=?,next_at=? WHERE id=?').run(Number(countFailure), error.slice(0, 1000), nextAt, id);
  }
  failedOutputCount(): number { return Number(this.db.prepare('SELECT count(*) n FROM outbox WHERE sent=0 AND failed_at IS NOT NULL').get()!.n); }
  pollingOffset(now = Date.now()): number {
    // Telegram may choose a lower ID after a week with no updates. Probe retained
    // updates from zero; records received in a new epoch get distinct local IDs.
    return this.get('legacy_offset_probe') === 'true' || now - Number(this.get('last_update_at') ?? now) >= IDLE_OFFSET_RESET_MS ? 0 : Number(this.get('offset') ?? 0);
  }
  ingest(updates: { update_id: number }[], accept: (update: any) => boolean, now = Date.now()): void {
    if (!updates.length) return;
    this.tx(() => {
      let epoch = Number(this.get('update_epoch') ?? 0);
      const reset = this.get('legacy_offset_probe') === 'true' || now - Number(this.get('last_update_at') ?? now) >= IDLE_OFFSET_RESET_MS;
      if (reset) { epoch++; this.set('update_epoch', String(epoch)); this.set('legacy_offset_probe', 'false'); }
      let offset = reset ? 0 : Number(this.get('offset') ?? 0);
      for (const update of updates) {
        if (!Number.isSafeInteger(update.update_id) || update.update_id < 0 || update.update_id === Number.MAX_SAFE_INTEGER) throw new Error('Некорректный Telegram update_id.');
        if (accept(update)) {
          let localId = update.update_id;
          const identity = updateIdentity(update);
          const known = identity ? this.db.prepare('SELECT local_id FROM telegram_seen WHERE identity=?').get(identity) : undefined;
          if (known) {
            if (epoch > 0) this.db.prepare('INSERT OR IGNORE INTO telegram_receipts VALUES (?,?,?)').run(epoch, update.update_id, known.local_id);
            offset = Math.max(offset, update.update_id + 1); continue;
          }
          if (epoch > 0) {
            const seen = this.db.prepare('SELECT local_id FROM telegram_receipts WHERE epoch=? AND update_id=?').get(epoch, update.update_id);
            if (seen) { offset = Math.max(offset, update.update_id + 1); continue; }
            localId = Number(this.get('local_update_id') ?? 0);
            if (!localId) localId = Number(this.db.prepare('SELECT max(n) n FROM (SELECT max(update_id) n FROM inbox UNION ALL SELECT max(update_id) n FROM jobs)').get()?.n ?? 0);
            localId++;
            if (!Number.isSafeInteger(localId)) throw new Error('Исчерпан диапазон локальных update ID.');
            this.set('local_update_id', String(localId));
            this.db.prepare('INSERT INTO telegram_receipts VALUES (?,?,?)').run(epoch, update.update_id, localId);
          }
          const inserted = this.db.prepare('INSERT OR IGNORE INTO inbox(update_id,payload,handled,received_at) VALUES (?,?,0,?)').run(localId, JSON.stringify({ ...update, update_id: localId }), now);
          if (identity && inserted.changes) this.db.prepare('INSERT OR IGNORE INTO telegram_seen VALUES (?,?)').run(identity, localId);
        }
        offset = Math.max(offset, update.update_id + 1);
      }
      this.set('offset', String(offset)); this.set('last_update_at', String(now));
    });
  }
  pruneTechnicalHistory(now = Date.now(), retentionDays = 30): { inbox: number; outbox: number } {
    if (!Number.isFinite(retentionDays) || retentionDays < 7) throw new Error('История доставки хранится минимум 7 дней.');
    const cutoff = now - retentionDays * 86_400_000;
    return this.tx(() => {
      // Keep small inbox tombstones: replaying an old update must never rerun work.
      const inbox = Number(this.db.prepare("UPDATE inbox SET payload='{}' WHERE update_id IN (SELECT update_id FROM inbox WHERE handled=1 AND payload<>'{}' AND received_at<? LIMIT 1000)").run(cutoff).changes);
      const outbox = Number(this.db.prepare('DELETE FROM outbox WHERE id IN (SELECT id FROM outbox WHERE sent=1 AND created<? LIMIT 1000)').run(cutoff).changes);
      return { inbox, outbox };
    });
  }
  pendingInput(): { update_id: number; payload: string } | undefined { return this.db.prepare('SELECT update_id,payload FROM inbox WHERE handled=0 ORDER BY update_id LIMIT 1').get() as { update_id: number; payload: string } | undefined; }
  handled(id: number): void { this.db.prepare('UPDATE inbox SET handled=1 WHERE update_id=?').run(id); }
  request(id: string): InputRequest | undefined { return this.db.prepare('SELECT * FROM requests WHERE id=?').get(id) as unknown as InputRequest | undefined; }
  recover(): number {
    return this.tx(() => {
      const interrupted = this.db.prepare("SELECT DISTINCT session_id FROM jobs WHERE state IN ('preparing','running','waiting_input')").all();
      const count = Number(this.db.prepare("UPDATE jobs SET state='unknown',result='Crowl перезапущен во время выполнения; автоматического повтора нет.' WHERE state IN ('preparing','running','waiting_input')").run().changes);
      this.db.prepare("UPDATE requests SET state='expired' WHERE state='pending'").run();
      for (const row of interrupted) this.setPaused(String(row.session_id), true);
      if (count) this.outgoing(`После перезапуска ${count} задача имеет неопределённый результат. Проверьте файлы. Очереди затронутых сессий на паузе: /sessions → /queue.`);
      return count;
    });
  }
  close(): void { this.db.close(); }
}

/** Online read-only backup: never runs migrations before copying old state. */
export async function backupState(data: string): Promise<string> {
  const source = join(data, 'crowl.sqlite');
  if (!existsSync(source)) throw new Error('Состояние Crowl ещё не создано.');
  const db = new DatabaseSync(source, { readOnly: true });
  const target = join(data, `backup-${Date.now()}-${randomUUID().slice(0, 8)}.sqlite`);
  const temporary = target + '.partial';
  try { await backup(db, temporary); chmodSync(temporary, 0o600); renameSync(temporary, target); return target; }
  finally { db.close(); rmSync(temporary, { force: true }); }
}

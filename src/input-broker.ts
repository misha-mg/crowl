import { randomUUID } from 'node:crypto';
import type { Store } from './storage.ts';
import type { AgentInput, AgentReply } from './providers/types.ts';
import { Interrupted } from './providers/types.ts';
import { deferred, errorText } from './process.ts';

type Waiter = {
  jobId: string; kind: AgentInput['kind']; questionId?: string;
  resolve: (reply: AgentReply) => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>; abort: () => void; signal: AbortSignal;
};
type BrokerOptions = { timeoutMs?: number; onFatal?: (error: Error) => void; getFatal?: () => Error | undefined };

/** Durable input requests with in-memory waiters for the currently running CLI. */
export class InputBroker {
  #store: Store; #options: BrokerOptions;
  #waiters = new Map<string, Waiter>();
  #fatal?: Error;
  constructor(store: Store, options: BrokerOptions = {}) { this.#store = store; this.#options = options; }

  lookup(id: string): Pick<Waiter, 'jobId' | 'kind' | 'questionId'> | undefined { return this.#waiters.get(id); }

  async ask(jobId: string, input: AgentInput, signal: AbortSignal): Promise<AgentReply> {
    if (input.kind === 'permission') return this.askOne(jobId, input, signal);
    const answers: Record<string, string> = {};
    for (const question of input.questions ?? []) {
      if (question.secret) throw new Error('Секретные ответы через Telegram не поддерживаются.');
      const reply = await this.askOne(jobId, {
        kind: 'question',
        title: `${input.title}\n\n${question.text}${question.options?.length ? '\nВарианты: ' + question.options.join(' / ') : ''}\n\nОтветьте через Reply на это сообщение.`,
        questions: [question],
      }, signal, question.id);
      Object.assign(answers, reply.answers);
    }
    return { answers };
  }

  /** Called after the inbox transaction has committed the answer. */
  answer(id: string, reply: AgentReply): void {
    const waiter = this.release(id); if (!waiter) return;
    const fatal = this.#fatal ?? this.#options.getFatal?.();
    if (fatal) waiter.reject(fatal); else waiter.resolve(reply);
  }

  rejectForJob(jobId: string, error: Error = new Interrupted()): void {
    for (const [id, waiter] of this.#waiters) if (waiter.jobId === jobId) this.reject(id, error);
  }

  /** Failed delivery expires the durable request; do not wait ten minutes. */
  poll(): void {
    for (const id of this.#waiters.keys()) {
      try {
        if (this.#store.request(id)?.state !== 'pending') this.reject(id, new Error('Запрос закрыт или не доставлен. Повторите задачу после восстановления связи.'));
      } catch (error) {
        const failure = this.storageFailure(error);
        for (const pending of this.#waiters.keys()) this.reject(pending, failure);
        return;
      }
    }
  }

  private askOne(jobId: string, input: AgentInput, signal: AbortSignal, questionId?: string): Promise<AgentReply> {
    if (signal.aborted) return Promise.reject(new Interrupted());
    const id = randomUUID().slice(0, 12), pending = deferred<AgentReply>();
    this.#store.tx(() => {
      this.#store.createInputRequest(id, jobId, input.kind, input.title);
      this.#store.state(jobId, 'waiting_input');
      this.#store.outgoing(input.title, input.kind === 'permission' ? {
        inline_keyboard: [[{ text: 'Разрешить один раз', callback_data: `reply:${id}:yes` }, { text: 'Отклонить', callback_data: `reply:${id}:no` }]],
      } : undefined, id, undefined, this.#store.job(jobId)?.origin_message_id ?? undefined);
    });
    const abort = () => this.reject(id, new Interrupted());
    const timer = setTimeout(() => this.reject(id, new Error('Истекло время ответа (10 минут).')), this.#options.timeoutMs ?? 600_000);
    this.#waiters.set(id, { jobId, resolve: pending.resolve, reject: pending.reject, timer, abort, signal, kind: input.kind, questionId });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return pending.promise;
  }

  private storageFailure(error: unknown): Error {
    const failure = error instanceof Error ? error : new Error(errorText(error));
    this.#fatal ??= failure; this.#options.onFatal?.(failure);
    return failure;
  }

  private release(id: string): Waiter | undefined {
    const waiter = this.#waiters.get(id); if (!waiter) return;
    clearTimeout(waiter.timer); waiter.signal.removeEventListener('abort', waiter.abort); this.#waiters.delete(id);
    try {
      if (this.#store.job(waiter.jobId)?.state === 'waiting_input' && ![...this.#waiters.values()].some(w => w.jobId === waiter.jobId)) this.#store.state(waiter.jobId, 'running');
    } catch (error) { this.storageFailure(error); }
    return waiter;
  }

  private reject(id: string, error: Error): void {
    const waiter = this.release(id); if (!waiter) return;
    try { this.#store.expireRequest(id); }
    catch (storageError) { this.storageFailure(storageError); }
    waiter.reject(error);
  }
}

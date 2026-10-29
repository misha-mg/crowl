import { deferred, errorText } from '../process.ts';
import { JsonProcess } from './wire.ts';
import type { Frame } from './wire.ts';
import type { Agent, AgentRun, Question } from './types.ts';
import { Interrupted, Uncertain } from './types.ts';
import { tokenCount } from '../metrics.ts';
import { realpathSync } from 'node:fs';

export class CodexAgent implements Agent {
  readonly provider = 'codex' as const;
  #binary: string; #wire?: JsonProcess;
  constructor(binary: string) { this.#binary = binary; }
  async run(options: AgentRun): Promise<string> {
    if (options.signal.aborted) throw new Interrupted();
    const wire = this.#wire = new JsonProcess(this.#binary, ['app-server', '--listen', 'stdio://'], options.cwd);
    const done = deferred<string>(); void done.promise.catch(() => {});
    let turnId: string | undefined, threadId: string | undefined, dispatched = false, terminal = false;
    let final = '', streamed = '';
    const summaries = new Map<string, Map<number, string>>();
    const requests = new Map<string, AbortController>();
    const abort = () => {
      if (turnId && threadId) void wire.request('turn/interrupt', { threadId, turnId }, false, 2000).catch(() => {}).finally(() => wire.close());
      else void wire.close();
      done.reject(new Interrupted());
    };
    options.signal.addEventListener('abort', abort, { once: true });
    wire.onClose = error => done.reject(dispatched ? new Uncertain(error.message) : error);
    wire.onFrame = frame => {
      const p = frame.params ?? {};
      if (frame.id !== undefined && frame.method) {
        const cancel = new AbortController(); requests.set(String(frame.id), cancel);
        void this.respond(wire, frame, options, cancel.signal).catch(error => { if (!cancel.signal.aborted) done.reject(error); }).finally(() => requests.delete(String(frame.id))); return;
      }
      if (frame.method === 'serverRequest/resolved') { requests.get(String(p.requestId))?.abort(); return; }
      if (p.threadId && threadId && p.threadId !== threadId) return;
      if (frame.method === 'thread/tokenUsage/updated' && p.tokenUsage) {
        options.callbacks.metrics?.({
          inputTokens: tokenCount(p.tokenUsage.total?.inputTokens), outputTokens: tokenCount(p.tokenUsage.total?.outputTokens), usageScope: 'session',
          contextTokens: tokenCount(p.tokenUsage.last?.totalTokens), contextWindow: tokenCount(p.tokenUsage.modelContextWindow),
        });
      }
      if (frame.method === 'thread/settings/updated' && typeof p.threadSettings?.model === 'string') options.callbacks.metrics?.({ model: p.threadSettings.model });
      if (frame.method === 'turn/started') turnId = p.turn?.id;
      if (frame.method === 'item/reasoning/summaryTextDelta' && typeof p.delta === 'string') {
        const key = String(p.itemId ?? 'current');
        const parts = summaries.get(key) ?? new Map<number, string>();
        const index = Number.isInteger(p.summaryIndex) ? p.summaryIndex : 0;
        parts.set(index, (parts.get(index) ?? '') + p.delta); summaries.set(key, parts);
        const text = [...parts.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n\n');
        if (text.trim()) options.callbacks.progress(text.slice(-3500));
      }
      if (frame.method === 'item/completed' && p.item?.type === 'reasoning' && Array.isArray(p.item.summary)) {
        const text = p.item.summary.filter((part: unknown) => typeof part === 'string').join('\n\n');
        if (text.trim()) options.callbacks.progress(text.slice(-3500));
      }
      if (frame.method === 'item/started' && p.item?.type === 'agentMessage') streamed = '';
      if (frame.method === 'item/agentMessage/delta') {
        streamed += p.delta ?? ''; options.callbacks.progress(streamed.slice(-3500));
      }
      if (frame.method === 'item/started' && p.item?.type !== 'reasoning' && p.item?.type !== 'agentMessage') options.callbacks.progress(`Выполняется: ${p.item?.type ?? 'инструмент'}`);
      if (frame.method === 'item/completed' && p.item?.type === 'agentMessage') {
        if (p.item.phase === 'commentary') { if (typeof p.item.text === 'string' && p.item.text.trim()) options.callbacks.progress(p.item.text.slice(-3500)); }
        else final += (final ? '\n\n' : '') + String(p.item.text ?? '');
      }
      if (frame.method === 'turn/completed') {
        terminal = true;
        if (p.turn?.status === 'completed') done.resolve(final || streamed || 'Готово.');
        else if (p.turn?.status === 'interrupted') done.reject(new Interrupted());
        else done.reject(new Error(p.turn?.error?.message ?? `Codex: ${p.turn?.status ?? 'неизвестный статус'}`));
      }
    };
    try {
      const initialized = await wire.request('initialize', { clientInfo: { name: 'crowl', title: 'Crowl', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      if (typeof initialized.userAgent !== 'string' || !initialized.userAgent) throw new Error('Codex не подтвердил протокол app-server. Выполните npm run probe.');
      wire.write({ method: 'initialized', params: {} });
      if (options.signal.aborted) throw new Interrupted();
      const settings = { cwd: options.cwd, approvalPolicy: options.mode === 'full' ? 'never' : 'untrusted', sandbox: options.mode === 'full' ? 'danger-full-access' : 'workspace-write', approvalsReviewer: 'user' };
      const response = await wire.request(options.nativeId ? 'thread/resume' : 'thread/start', options.nativeId ? { ...settings, threadId: options.nativeId } : settings);
      threadId = response.thread?.id;
      if (typeof threadId !== 'string' || !threadId.trim()) throw new Error('Codex не вернул корректный thread ID.');
      if (options.nativeId && threadId !== options.nativeId) throw new Error('Codex вернул другую сессию вместо запрошенной. Запуск отменён.');
      if (response.cwd !== undefined && (typeof response.cwd !== 'string' || realpathSync(response.cwd) !== realpathSync(options.cwd))) throw new Error('Codex применил другую рабочую директорию. Запуск отменён.');
      options.callbacks.nativeId(threadId);
      if (typeof response.model === 'string') options.callbacks.metrics?.({ model: response.model });
      const applied = `${response.approvalPolicy ?? 'unknown'} / ${response.sandbox?.type ?? 'unknown'}`;
      options.callbacks.applied(applied);
      if (options.mode === 'full' && (response.approvalPolicy !== 'never' || response.sandbox?.type !== 'dangerFullAccess')) throw new Error(`Политика Codex отклонила full: ${applied}`);
      if (options.mode === 'ask' && (response.approvalPolicy !== 'untrusted' || response.sandbox?.type !== 'workspaceWrite')) throw new Error(`Политика Codex отклонила ask: ${applied}`);
      if (options.signal.aborted) throw new Interrupted();
      dispatched = true;
      const started = await wire.request('turn/start', { threadId, summary: 'auto', input: [{ type: 'text', text: options.prompt, text_elements: [] }] });
      if (typeof started.turn?.id !== 'string' || !started.turn.id) throw new Error('Codex не подтвердил ID запущенной задачи.');
      turnId = started.turn.id;
      return await done.promise;
    } catch (error) {
      if (options.signal.aborted) throw new Interrupted();
      if (dispatched && !terminal) throw new Uncertain(errorText(error));
      throw error;
    } finally {
      options.signal.removeEventListener('abort', abort);
      for (const request of requests.values()) request.abort();
      await wire.close(); this.#wire = undefined;
    }
  }
  private async respond(wire: JsonProcess, frame: Frame, options: AgentRun, cancellation: AbortSignal): Promise<void> {
    const p = frame.params ?? {};
    let result: object;
    if (frame.method === 'item/tool/requestUserInput') {
      const questions: Question[] = (p.questions ?? []).map((q: any) => ({ id: q.id, text: q.question, options: q.options?.map((o: any) => o.label), secret: q.isSecret }));
      if (questions.some(q => q.secret)) throw new Error('Секретный ответ нельзя вводить в Telegram. Ответьте локально.');
      const reply = await options.callbacks.input({ kind: 'question', title: 'Codex задаёт вопрос', questions }, cancellation);
      result = { answers: Object.fromEntries(questions.map(q => [q.id, { answers: [reply.answers?.[q.id] ?? 'Отменено'] }])) };
    } else if (frame.method === 'item/commandExecution/requestApproval' || frame.method === 'item/fileChange/requestApproval') {
      const reply = await options.callbacks.input({ kind: 'permission', title: `Codex: ${p.command ?? p.reason ?? 'Изменение файлов'}${p.cwd ? `\nДиректория: ${p.cwd}` : ''}` }, cancellation);
      result = { decision: reply.allow ? 'accept' : 'decline' };
    } else if (frame.method === 'item/permissions/requestApproval') {
      const reply = await options.callbacks.input({ kind: 'permission', title: `Codex запрашивает доступ:\n${JSON.stringify(p.permissions ?? {})}` }, cancellation);
      result = { permissions: reply.allow ? (p.permissions ?? {}) : {}, scope: 'turn' };
    } else {
      wire.write({ id: frame.id, error: { code: -32601, message: 'Crowl does not support this client request' } }); return;
    }
    if (!options.signal.aborted && !cancellation.aborted) wire.write({ id: frame.id, result });
  }
  async close(): Promise<void> { await this.#wire?.close(); }
}

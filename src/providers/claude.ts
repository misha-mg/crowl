import { randomUUID } from 'node:crypto';
import { agentEnv } from '../config.ts';
import { deferred, errorText } from '../process.ts';
import { JsonProcess } from './wire.ts';
import type { Frame } from './wire.ts';
import type { Agent, AgentRun, Question } from './types.ts';
import { Interrupted, Uncertain } from './types.ts';
import { tokenCount } from '../metrics.ts';

// The control channel follows the official SDK subprocess protocol, pinned/tested
// against CLI 2.1.312. See docs/ADR-001.md before upgrading the supported CLI.
export class ClaudeAgent implements Agent {
  readonly provider = 'claude' as const;
  #binary: string; #wire?: JsonProcess;
  constructor(binary: string) { this.#binary = binary; }
  async run(options: AgentRun): Promise<string> {
    if (options.signal.aborted) throw new Interrupted();
    const mode = options.mode === 'full' ? 'bypassPermissions' : 'manual';
    const args = ['--print', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json', '--include-partial-messages', '--thinking-display', 'summarized', '--permission-prompt-tool', 'stdio', '--permission-mode', mode];
    if (options.mode === 'full') args.push('--dangerously-skip-permissions');
    if (options.nativeId) args.push(`--resume=${options.nativeId}`);
    else args.push(`--session-id=${randomUUID()}`);
    const wire = this.#wire = new JsonProcess(this.#binary, args, options.cwd, { ...agentEnv(), CLAUDE_CODE_SDK_READS_SESSION_STATE: '1' });
    const done = deferred<string>(); void done.promise.catch(() => {});
    let sent = false, final = '', streamed = '', thinking = '', state: string | undefined, result: Frame | undefined, model: string | undefined;
    const observeMessage = (message: Frame) => {
      if (typeof message.model === 'string') { model = message.model; options.callbacks.metrics?.({ model }); }
      const usage = message.usage;
      if (usage && tokenCount(usage.input_tokens) !== undefined) {
        const contextTokens = usage.input_tokens + (tokenCount(usage.cache_read_input_tokens) ?? 0) + (tokenCount(usage.cache_creation_input_tokens) ?? 0);
        options.callbacks.metrics?.({ contextTokens });
      }
    };
    const requests = new Map<string, AbortController>();
    const finish = () => {
      if (!result || (state && state !== 'idle')) return;
      if (result.is_error || result.subtype !== 'success') done.reject(new Error(result.errors?.join('; ') || result.result || `Claude: ${result.subtype}`));
      else done.resolve(result.result || final || streamed || 'Готово.');
    };
    const abort = () => {
      void wire.request('interrupt', {}, true, 2000).catch(() => {}).finally(() => wire.close());
      done.reject(new Interrupted());
    };
    options.signal.addEventListener('abort', abort, { once: true });
    wire.onClose = error => done.reject(sent ? new Uncertain(error.message) : error);
    wire.onFrame = frame => {
      if (frame.type === 'control_request') {
        const cancel = new AbortController(); requests.set(frame.request_id, cancel);
        void this.respond(wire, frame, options, cancel.signal).catch(error => { if (!cancel.signal.aborted) done.reject(error); }).finally(() => requests.delete(frame.request_id)); return;
      }
      if (frame.type === 'control_cancel_request') { requests.get(frame.request_id)?.abort(); return; }
      if (frame.type === 'system' && frame.subtype === 'init') {
        if (typeof frame.session_id !== 'string' || !frame.session_id || (options.nativeId && frame.session_id !== options.nativeId)) {
          done.reject(new Error('Claude не подтвердил запрошенную сессию. Запуск остановлен.')); return;
        }
        if (typeof frame.model === 'string') { model = frame.model; options.callbacks.metrics?.({ model }); }
        if (frame.session_id) options.callbacks.nativeId(frame.session_id);
        options.callbacks.applied(frame.permissionMode ?? `${mode} (CLI accepted; managed rules may apply)`);
        if (frame.permissionMode && frame.permissionMode !== mode) done.reject(new Error(`Claude применил ${frame.permissionMode} вместо ${mode}`));
      }
      if (frame.type === 'system' && frame.subtype === 'session_state_changed') { state = frame.state; finish(); }
      if (frame.type === 'system' && frame.subtype === 'task_progress' && typeof frame.description === 'string' && frame.description.trim()) options.callbacks.progress(frame.description.slice(-3500));
      // Claude's public thinking blocks contain the provider's readable summary.
      // Keep these in transient progress; signatures/redacted blocks never render.
      if (frame.type === 'stream_event' && !frame.parent_tool_use_id && frame.event?.type === 'content_block_start' && frame.event.content_block?.type === 'thinking') {
        thinking = typeof frame.event.content_block.thinking === 'string' ? frame.event.content_block.thinking : '';
        if (thinking.trim()) options.callbacks.progress(thinking.slice(-3500));
      }
      if (frame.type === 'stream_event' && !frame.parent_tool_use_id && frame.event?.type === 'content_block_delta' && frame.event.delta?.type === 'thinking_delta' && typeof frame.event.delta.thinking === 'string') {
        thinking += frame.event.delta.thinking;
        if (thinking.trim()) options.callbacks.progress(thinking.slice(-3500));
      }
      if (frame.type === 'stream_event' && !frame.parent_tool_use_id && frame.event?.type === 'content_block_start' && frame.event.content_block?.type === 'tool_use') options.callbacks.progress(`Выполняется: ${frame.event.content_block.name ?? 'инструмент'}`);
      if (frame.type === 'stream_event' && !frame.parent_tool_use_id && frame.event?.type === 'message_start') observeMessage(frame.event.message ?? {});
      if (frame.type === 'stream_event' && !frame.parent_tool_use_id && frame.event?.type === 'content_block_start' && frame.event.content_block?.type === 'text') streamed = '';
      if (frame.type === 'stream_event' && !frame.parent_tool_use_id && frame.event?.delta?.type === 'text_delta') { streamed += frame.event.delta.text; options.callbacks.progress(streamed.slice(-3500)); }
      if (frame.type === 'assistant' && !frame.parent_tool_use_id) {
        observeMessage(frame.message ?? {});
        for (const block of frame.message?.content ?? []) {
          if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) options.callbacks.progress(block.thinking.slice(-3500));
          if (block.type === 'text' && typeof block.text === 'string') { final += (final ? '\n\n' : '') + block.text; if (block.text.trim()) options.callbacks.progress(block.text.slice(-3500)); }
          if (block.type === 'tool_use') options.callbacks.progress(`Выполняется: ${block.name}`);
        }
      }
      if (frame.type === 'result') {
        const usage = frame.usage;
        if (usage) options.callbacks.metrics?.({
          inputTokens: tokenCount(usage.input_tokens) === undefined ? undefined : usage.input_tokens + (tokenCount(usage.cache_read_input_tokens) ?? 0) + (tokenCount(usage.cache_creation_input_tokens) ?? 0),
          outputTokens: tokenCount(usage.output_tokens), usageScope: 'cli',
        });
        const window = model ? tokenCount(frame.modelUsage?.[model]?.contextWindow) : undefined;
        if (window !== undefined) options.callbacks.metrics?.({ contextWindow: window });
        result = frame; finish();
      }
    };
    try {
      await wire.request('initialize', { hooks: null }, true);
      if (options.signal.aborted) throw new Interrupted();
      // Override a resumed session's omitted display as well as the spawn default.
      await wire.request('set_max_thinking_tokens', { thinking_display: 'summarized' }, true);
      if (options.signal.aborted) throw new Interrupted();
      // This ack validates the requested mode even when init omits permissionMode.
      await wire.request('set_permission_mode', { mode }, true);
      options.callbacks.applied(`${mode} (принят CLI; системные правила сохраняются)`);
      if (options.signal.aborted) throw new Interrupted();
      sent = true;
      wire.write({ type: 'user', session_id: options.nativeId ?? '', parent_tool_use_id: null, client_composed: true, message: { role: 'user', content: options.prompt } });
      return await done.promise;
    } catch (error) {
      if (options.signal.aborted) throw new Interrupted();
      if (sent && !result) throw new Uncertain(errorText(error));
      throw error;
    } finally {
      options.signal.removeEventListener('abort', abort);
      for (const request of requests.values()) request.abort();
      await wire.close(); this.#wire = undefined;
    }
  }
  private async respond(wire: JsonProcess, frame: Frame, options: AgentRun, cancellation: AbortSignal): Promise<void> {
    const request = frame.request ?? {};
    if (request.subtype !== 'can_use_tool') {
      wire.write({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'Unsupported Crowl control request' } }); return;
    }
    let response: object;
    if (request.tool_name === 'AskUserQuestion') {
      const raw = request.input?.questions ?? [];
      const questions: Question[] = raw.map((q: any, index: number) => ({ id: String(index), text: q.question, options: q.options?.map((o: any) => o.label) }));
      const reply = await options.callbacks.input({ kind: 'question', title: 'Claude задаёт вопрос', questions }, cancellation);
      response = { behavior: 'allow', updatedInput: { ...request.input, answers: Object.fromEntries(raw.map((q: any, index: number) => [q.question, reply.answers?.[String(index)] ?? 'Отменено'])) } };
    } else {
      const reply = await options.callbacks.input({ kind: 'permission', title: `Claude: ${request.tool_name}\n${JSON.stringify(request.input ?? {})}` }, cancellation);
      response = reply.allow ? { behavior: 'allow', updatedInput: request.input } : { behavior: 'deny', message: 'Владелец отклонил действие.' };
    }
    if (!options.signal.aborted && !cancellation.aborted) wire.write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } });
  }
  async close(): Promise<void> { await this.#wire?.close(); }
}

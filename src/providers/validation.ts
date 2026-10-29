// Validate the fields that drive control flow; tolerate unknown notification types
// and additional fields so compatible CLI extensions do not require a release.
export const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const id = (value: unknown) => typeof value === 'string' && value.length > 0 || typeof value === 'number' && Number.isSafeInteger(value);
const text = (value: unknown) => typeof value === 'string';
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
function requireShape(condition: unknown): asserts condition {
  if (!condition) throw new Error('Несовместимый формат протокола агента. Выполните npm run probe и проверьте версию CLI.');
}

export function validateFrame(value: unknown): asserts value is Record<string, any> {
  requireShape(record(value));
  const frame = value;
  if ('method' in frame) {
    requireShape(text(frame.method) && !!frame.method && optional(frame.id, id) && optional(frame.params, record));
    const p = (frame.params ?? {}) as Record<string, unknown>;
    requireShape(optional(p.threadId, text) && optional(p.turnId, text));
    if (frame.method === 'turn/started' || frame.method === 'turn/completed') {
      requireShape(record(p.turn) && id(p.turn.id));
      if (frame.method === 'turn/completed') requireShape(['completed', 'interrupted', 'failed'].includes(String(p.turn.status)));
    }
    if (frame.method === 'item/agentMessage/delta') requireShape(text(p.delta));
    if (frame.method === 'item/started' || frame.method === 'item/completed') {
      requireShape(record(p.item) && text(p.item.type));
      if (p.item.type === 'agentMessage') requireShape(optional(p.item.text, text));
    }
    if (frame.method === 'item/tool/requestUserInput') {
      requireShape(Array.isArray(p.questions) && p.questions.length > 0);
      for (const q of p.questions) {
        requireShape(record(q) && text(q.id) && !!q.id && text(q.question));
        requireShape(optional(q.options, Array.isArray) && optional(q.isSecret, v => typeof v === 'boolean'));
        for (const option of (q.options ?? []) as unknown[]) requireShape(record(option) && text(option.label));
      }
    }
    return;
  }
  if ('type' in frame) {
    requireShape(text(frame.type) && !!frame.type);
    if (frame.type === 'control_response') {
      const response = frame.response;
      requireShape(record(response) && id(response.request_id));
      requireShape(response.subtype === 'success' || response.subtype === 'error');
      if (response.subtype === 'success') requireShape(optional(response.response, record));
      else requireShape(text(response.error));
    } else if (frame.type === 'control_request') {
      requireShape(id(frame.request_id) && record(frame.request) && text(frame.request.subtype));
      if (frame.request.subtype === 'can_use_tool') {
        requireShape(text(frame.request.tool_name) && record(frame.request.input));
        if (frame.request.tool_name === 'AskUserQuestion') {
          const questions = frame.request.input.questions;
          requireShape(Array.isArray(questions) && questions.length > 0);
          for (const q of questions) {
            requireShape(record(q) && text(q.question) && optional(q.options, Array.isArray));
            for (const option of (q.options ?? []) as unknown[]) requireShape(record(option) && text(option.label));
          }
        }
      }
    } else if (frame.type === 'control_cancel_request') requireShape(id(frame.request_id));
    else if (frame.type === 'result') {
      requireShape(text(frame.subtype) && optional(frame.result, text) && optional(frame.is_error, v => typeof v === 'boolean'));
      requireShape(optional(frame.errors, v => Array.isArray(v) && v.every(text)));
    } else if (frame.type === 'assistant') {
      requireShape(record(frame.message) && Array.isArray(frame.message.content));
      for (const block of frame.message.content) {
        requireShape(record(block) && text(block.type));
        if (block.type === 'text') requireShape(text(block.text));
        if (block.type === 'tool_use') requireShape(text(block.name));
      }
    } else if (frame.type === 'stream_event') {
      requireShape(record(frame.event));
      if (frame.event.delta !== undefined) {
        requireShape(record(frame.event.delta));
        if (frame.event.delta.type === 'text_delta') requireShape(text(frame.event.delta.text));
      }
    } else if (frame.type === 'system') {
      requireShape(optional(frame.subtype, text));
      if (frame.subtype === 'init') requireShape(optional(frame.session_id, text) && optional(frame.permissionMode, text));
      if (frame.subtype === 'session_state_changed') requireShape(text(frame.state));
    }
    return;
  }
  requireShape(id(frame.id) && ('result' in frame || 'error' in frame));
  if ('error' in frame) requireShape(record(frame.error) && text(frame.error.message));
  else requireShape(frame.result === null || record(frame.result));
}

/** Only known diagnostic categories escape stderr. Raw stderr may contain credentials or prompts. */
export function stderrHint(stderr: string): string | undefined {
  if (/not (?:logged|signed) in|unauthori[sz]ed|authentication (?:failed|required)|invalid api key|login required/i.test(stderr)) return 'Проверьте авторизацию CLI под пользователем сервиса.';
  if (/operation not permitted|permission denied|EACCES|EPERM/i.test(stderr)) return 'ОС запретила запуск или доступ к файлам. Проверьте права пользователя сервиса.';
  if (/unknown (?:option|argument)|unrecognized (?:option|argument)|unexpected argument|unsupported protocol/i.test(stderr)) return 'CLI не поддерживает параметры протокола. Выполните npm run probe и проверьте версию CLI.';
  if (/rate.?limit|quota exceeded|insufficient_quota/i.test(stderr)) return 'Проверьте лимиты аккаунта провайдера.';
  return undefined;
}

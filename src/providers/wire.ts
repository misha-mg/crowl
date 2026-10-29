import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { deferred, launch, terminate } from '../process.ts';
import { validateFrame, stderrHint } from './validation.ts';

export type Frame = Record<string, any>;
export class JsonProcess {
  readonly child: ChildProcessWithoutNullStreams;
  #buffer = ''; #closed = false; #counter = 0; #stderr = '';
  #pending = new Map<string, ReturnType<typeof deferred<Frame>>>();
  onFrame: (frame: Frame) => void = () => {};
  onClose: (error: Error) => void = () => {};
  constructor(binary: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
    this.child = launch(binary, args, cwd, env);
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      if (this.#closed) return;
      this.#buffer += chunk;
      if (this.#buffer.length > 8_000_000) return this.fail(new Error('Слишком большой JSON frame агента.'));
      let newline: number;
      while ((newline = this.#buffer.indexOf('\n')) !== -1) {
        const line = this.#buffer.slice(0, newline).trim(); this.#buffer = this.#buffer.slice(newline + 1);
        if (!line) continue;
        if (!line.startsWith('{')) {
          if (line.startsWith('[') || line === 'null') { this.fail(new Error('Несовместимый JSON frame агента. Выполните npm run probe.')); return; }
          continue;
        }
        let frame: unknown;
        try { frame = JSON.parse(line); } catch { this.fail(new Error('Повреждённый JSON frame агента.')); return; }
        try { validateFrame(frame); } catch (error) { this.fail(error as Error); return; }
        try { this.dispatch(frame); } catch { this.fail(new Error('Неподдерживаемое сообщение агента. Выполните npm run probe.')); return; }
      }
    });
    // Keep only a bounded in-memory tail, expose allowlisted advice, never raw text.
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => { this.#stderr = (this.#stderr + chunk).slice(-8192); });
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.once('close', (code, signal) => {
      const hint = stderrHint(this.#stderr); this.#stderr = '';
      this.fail(new Error(`Процесс агента закрыт: ${code ?? signal ?? 'unknown'}${hint ? `. ${hint}` : ''}`));
    });
  }
  private dispatch(frame: Frame): void {
    let id: string | undefined, result: Frame | undefined, error: string | undefined;
    if (frame.type === 'control_response') {
      id = String(frame.response?.request_id); result = frame.response?.response ?? {};
      if (frame.response?.subtype === 'error') error = frame.response?.error ?? 'Control error';
    } else if ('id' in frame && !('method' in frame)) {
      id = String(frame.id); result = frame.result ?? {}; error = frame.error?.message;
    }
    if (id && this.#pending.has(id)) {
      const pending = this.#pending.get(id)!; this.#pending.delete(id);
      if (error) pending.reject(new Error(error)); else pending.resolve(result ?? {});
    } else this.onFrame(frame);
  }
  write(frame: Frame): void {
    if (this.#closed) throw new Error('Канал агента закрыт.');
    this.child.stdin.write(JSON.stringify(frame) + '\n');
  }
  async request(method: string, params: Frame = {}, claude = false, timeoutMs = 30_000): Promise<Frame> {
    if (this.#closed) throw new Error('Канал агента закрыт.');
    const id = String(++this.#counter); const pending = deferred<Frame>(); this.#pending.set(id, pending);
    const timer = setTimeout(() => { this.#pending.delete(id); pending.reject(new Error(`Агент не ответил: ${method}`)); }, timeoutMs);
    try {
      this.write(claude ? { type: 'control_request', request_id: id, request: { subtype: method, ...params } } : { id, method, params });
      return await pending.promise;
    } finally { clearTimeout(timer); this.#pending.delete(id); }
  }
  private fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear(); this.onClose(error);
    void terminate(this.child);
  }
  async close(): Promise<void> {
    if (!this.#closed) { this.fail(new Error('Канал закрыт Crowl.')); }
    await terminate(this.child);
  }
}

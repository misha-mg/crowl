import type { PermissionMode, Provider } from '../config.ts';
export interface Question { id: string; text: string; options?: string[]; secret?: boolean }
export interface AgentInput { kind: 'permission' | 'question'; title: string; questions?: Question[] }
export interface AgentReply { allow?: boolean; answers?: Record<string, string> }
export interface AgentMetrics {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  usageScope?: 'session' | 'cli';
  contextTokens?: number;
  contextWindow?: number;
}
export interface AgentCallbacks {
  nativeId(id: string): void;
  applied(description: string): void;
  progress(text: string): void;
  input(request: AgentInput, cancellation?: AbortSignal): Promise<AgentReply>;
  metrics?(snapshot: AgentMetrics): void;
}
export interface AgentRun { cwd: string; mode: PermissionMode; nativeId: string | null; prompt: string; signal: AbortSignal; callbacks: AgentCallbacks }
export interface Agent { provider: Provider; run(options: AgentRun): Promise<string>; close(): Promise<void> }
export class Interrupted extends Error { constructor() { super('Выполнение прервано. Уже изменённые файлы не откатываются.'); } }
export class Uncertain extends Error { constructor(message = 'Связь с агентом потеряна. Проверьте файлы; автоматического повтора нет.') { super(message); } }

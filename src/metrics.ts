import { capture } from './process.ts';
import type { AgentMetrics } from './providers/types.ts';

export const tokenCount = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const count = (n: number) => n.toLocaleString('ru-RU');
export function formatMetrics(metrics: AgentMetrics): string[] {
  const usage = metrics.inputTokens === undefined && metrics.outputTokens === undefined ? 'нет данных от агента'
    : `вход ${metrics.inputTokens === undefined ? '—' : count(metrics.inputTokens)} · выход ${metrics.outputTokens === undefined ? '—' : count(metrics.outputTokens)} токенов`;
  let context = 'нет данных от агента';
  if (metrics.contextTokens !== undefined) {
    context = count(metrics.contextTokens);
    if (metrics.contextWindow) context += ` / ${count(metrics.contextWindow)} (${Math.round(metrics.contextTokens / metrics.contextWindow * 100)}%)`;
    context += ' токенов · последний запрос';
  } else if (metrics.contextWindow) context = `окно ${count(metrics.contextWindow)} токенов · заполнение неизвестно`;
  return [`Модель: ${metrics.model ?? 'ещё не сообщена агентом'}`, `Usage${metrics.usageScope === 'session' ? ' (сессия)' : metrics.usageScope === 'cli' ? ' (данные CLI)' : ''}: ${usage}`, `Контекст: ${context}`];
}
export async function gitBranch(project: string): Promise<string> {
  try {
    const branch = await capture('git', ['-C', project, 'symbolic-ref', '--quiet', '--short', 'HEAD'], project, 2000);
    if (branch.code === 0 && branch.stdout.trim()) return branch.stdout.trim();
    const head = await capture('git', ['-C', project, 'rev-parse', '--short', 'HEAD'], project, 2000);
    return head.code === 0 ? `detached HEAD · ${head.stdout.trim()}` : 'не Git-репозиторий или HEAD отсутствует';
  } catch { return 'не удалось прочитать'; }
}

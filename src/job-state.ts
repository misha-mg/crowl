export type RunState = 'queued' | 'preparing' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'interrupted' | 'unknown';

const transitions: Record<RunState, readonly RunState[]> = {
  queued: ['preparing', 'running', 'interrupted'],
  preparing: ['running', 'failed', 'interrupted', 'unknown'],
  running: ['waiting_input', 'completed', 'failed', 'interrupted', 'unknown'],
  waiting_input: ['running', 'completed', 'failed', 'interrupted', 'unknown'],
  completed: [], failed: [], interrupted: [], unknown: [],
};

export function assertTransition(from: RunState, to: RunState): void {
  if (from !== to && !transitions[from]?.includes(to)) throw new Error(`Недопустимый переход задачи: ${from} → ${to}.`);
}

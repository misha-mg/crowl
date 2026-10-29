import type { Job } from './storage.ts';

/** FIFO across eligible sessions, at most one job per session. No I/O or mutation. */
export function selectRunnableJobs(
  queue: readonly Job[], running: ReadonlySet<string>, closing: ReadonlySet<string>,
  paused: (sessionId: string) => boolean, limit: number,
): Job[] {
  const selected: Job[] = [], reserved = new Set(running);
  for (const job of queue) {
    if (reserved.size >= limit) break;
    if (reserved.has(job.session_id) || closing.has(job.session_id) || paused(job.session_id)) continue;
    reserved.add(job.session_id); selected.push(job);
  }
  return selected;
}

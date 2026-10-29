import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { agentEnv } from './config.ts';

type OwnedGroup = { pid?: number; gone: boolean; termination?: Promise<void> };
const groups = new WeakMap<ChildProcessWithoutNullStreams, OwnedGroup>();
function groupExists(group: OwnedGroup): boolean {
  if (group.gone || !group.pid) return false;
  try { process.kill(-group.pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') group.gone = true;
    return !group.gone;
  }
}
export function launch(binary: string, args: string[], cwd: string, env = agentEnv()): ChildProcessWithoutNullStreams {
  const child = spawn(binary, args, { cwd, env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const group: OwnedGroup = { pid: child.pid, gone: !child.pid };
  groups.set(child, group);
  // Retire a vanished group permanently; a later close() must not signal a reused PID.
  child.once('close', () => { groupExists(group); });
  return child;
}
export function terminate(child: ChildProcessWithoutNullStreams, graceMs = 1500): Promise<void> {
  const group = groups.get(child);
  // Negative-PID signals are reserved for groups created by launch(), never caller PIDs.
  if (!group) return Promise.reject(new Error('Процесс не принадлежит Crowl.'));
  if (group.termination) return group.termination;
  group.termination = (async () => {
    if (!groupExists(group)) return;
    const signal = (value: NodeJS.Signals) => {
      if (!groupExists(group)) return;
      try { process.kill(-group.pid!, value); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') group.gone = true; else throw error; }
    };
    signal('SIGTERM');
    const deadline = Date.now() + Math.max(0, graceMs);
    // The leader may exit first, and close may fire while tools still run with closed stdio.
    while (groupExists(group) && Date.now() < deadline) await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
    if (groupExists(group)) signal('SIGKILL');
    const reapDeadline = Date.now() + 500;
    while (groupExists(group) && Date.now() < reapDeadline) await sleep(10);
    // Never signal this lease again, even on a second close or an unreaped zombie.
    group.gone = true;
  })();
  return group.termination;
}
export async function capture(binary: string, args: string[], cwd: string, timeoutMs = 8000, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  signal?.throwIfAborted();
  const child = launch(binary, args, cwd);
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', settled = false;
    const finish = async (error?: Error, code: number | null = null) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { await terminate(child); reject(error); } else resolve({ code, stdout, stderr });
    };
    const abort = () => { void finish(new Error('Операция отменена.')); };
    const timer = setTimeout(() => { void finish(new Error(`${binary}: timeout`)); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-200_000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20_000); });
    child.stdin.on('error', () => {});
    child.on('error', error => { void finish(error); });
    child.on('close', code => { void finish(undefined, code); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.end();
  });
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  if (signal?.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal?.addEventListener('abort', done, { once: true });
});

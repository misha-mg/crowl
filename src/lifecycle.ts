/** Separates an owner's stop from cancellation caused by a failing runtime loop. */
export class RuntimeLifecycle {
  readonly shutdown = new AbortController();
  #requested = false;
  #failed = false;

  requestStop(): void {
    // A later SIGTERM must not turn an already recorded failure into success.
    if (this.shutdown.signal.aborted) return;
    this.#requested = true;
    this.shutdown.abort();
  }

  async supervise(loops: readonly (() => Promise<void>)[]): Promise<void> {
    const pending = loops.map(loop => Promise.resolve().then(loop));
    try { await Promise.all(pending); }
    catch (error) {
      if (!this.#requested) this.#failed = true;
      throw error;
    } finally {
      this.shutdown.abort();
      await Promise.allSettled(pending);
    }
  }

  failure(error: unknown, report: (error: unknown) => void): number {
    if (this.#requested && !this.#failed) return 0;
    this.#failed = true;
    report(error);
    return 1;
  }
}

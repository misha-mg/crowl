import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, until } from './helpers.ts';
import { CodexAgent } from '../src/providers/codex.ts';
import { ClaudeAgent } from '../src/providers/claude.ts';
import { Interrupted, Uncertain } from '../src/providers/types.ts';
import type { AgentRun, AgentReply, AgentMetrics } from '../src/providers/types.ts';

for (const provider of ['codex', 'claude'] as const) {
  function setup() {
    const f = fixture(); const binary = join(f.dir, 'agent with spaces');
    copyFileSync(fileURLToPath(new URL('./fixtures/agent.mjs', import.meta.url)), binary); chmodSync(binary, 0o700);
    const make = () => provider === 'codex' ? new CodexAgent(binary) : new ClaudeAgent(binary);
    const state = { native: null as string | null, applied: '', progress: [] as string[], metrics: {} as AgentMetrics };
    const options = (prompt: string, reply: AgentReply = { allow: true }): AgentRun => ({ cwd: f.dir, mode: 'full', nativeId: state.native, prompt, signal: new AbortController().signal, callbacks: {
      nativeId: id => { state.native = id; }, applied: mode => { state.applied = mode; }, progress: value => { state.progress.push(value); }, input: async () => reply,
      metrics: value => Object.assign(state.metrics, value),
    } });
    return { ...f, make, state, options };
  }
  test(`${provider}: real stdio process, file changes, exact resume, Unicode and no reasoning leak`, async () => {
    const f = setup(); try {
      assert.equal(await f.make().run(f.options('first')), 'result: first'); assert.ok(f.state.native); assert.ok(f.state.applied);
      assert.equal(await f.make().run(f.options('second')), 'result: second'); assert.equal(readFileSync(join(f.dir, 'changed.txt'), 'utf8'), 'second');
      assert.equal(f.state.metrics.model, `${provider}-fixture`);
      assert.equal(f.state.metrics.contextWindow, 10000);
      assert.equal(f.state.metrics.contextTokens, provider === 'codex' ? 500 : 350);
      assert.equal(f.state.metrics.inputTokens, provider === 'codex' ? 1200 : 1250);
      assert.equal(f.state.metrics.outputTokens, provider === 'codex' ? 300 : 75);
      assert.ok(f.state.progress.some(p => p.includes('🌍'))); assert.ok(f.state.progress.every(p => !p.includes('PRIVATE_REASONING')));
      await assert.rejects(() => f.make().run({ ...f.options('third'), nativeId: 'wrong-id' }), /Unknown exact|Wrong resume/);
    } finally { await f.close(); }
  });
  test(`${provider}: approve/deny and user question responses use matching wire format`, async () => {
    const f = setup(); try {
      const request = f.options('approval', { allow: false }); request.mode = 'ask';
      assert.equal(await f.make().run(request), 'result: denied');
      assert.equal(await f.make().run(f.options('approval')), 'result: approved');
      assert.equal(await f.make().run(f.options('question', { answers: { q: 'B', '0': 'B' } })), 'result: B');
    } finally { await f.close(); }
  });
  test(`${provider}: disconnect is uncertain; explicit failed result is failure`, async () => {
    const f = setup(); try {
      await assert.rejects(() => f.make().run(f.options('crash')), Uncertain);
      await assert.rejects(() => f.make().run(f.options('failed')), error => error instanceof Error && !(error instanceof Uncertain));
      await assert.rejects(() => f.make().run(f.options('broken-json')), Uncertain);
    } finally { await f.close(); }
  });
  test(`${provider}: interrupt stops process, no lost queue control`, async () => {
    const f = setup(); try {
      const abort = new AbortController(), agent = f.make();
      const task = agent.run({ ...f.options('pause'), signal: abort.signal });
      await until(() => !!f.state.native); abort.abort(); await assert.rejects(() => task, Interrupted); await agent.close();
    } finally { await f.close(); }
  });
  test(`${provider}: stop during a stalled handshake does not wait 30 seconds`, async () => {
    const f = setup(); try {
      const binary = join(f.dir, 'stall'); writeFileSync(binary, '#!/usr/bin/env node\nprocess.stdin.resume();\n'); chmodSync(binary, 0o700);
      const agent = provider === 'codex' ? new CodexAgent(binary) : new ClaudeAgent(binary);
      const abort = new AbortController(), started = Date.now();
      const pending = agent.run({ ...f.options('unused'), signal: abort.signal });
      const timer = setTimeout(() => abort.abort(), 80);
      try { await assert.rejects(() => pending, Interrupted); assert.ok(Date.now() - started < 4000); }
      finally { clearTimeout(timer); await agent.close(); }
    } finally { await f.close(); }
  });
  test(`${provider}: provider-cancelled permission does not abort a successful turn`, async () => {
    const f = setup(); try {
      const options = f.options('cancel'); let cancelled = false;
      options.callbacks.input = async (_input, signal) => new Promise((_yes, no) => {
        signal?.addEventListener('abort', () => { cancelled = true; no(new Error('cancelled')); }, { once: true });
      });
      assert.equal(await f.make().run(options), 'result: cancel'); assert.equal(cancelled, true);
    } finally { await f.close(); }
  });
  test(`${provider}: two native sessions in the same project resume independently`, async () => {
    const f = setup(); try {
      let a: string | null = null, b: string | null = null;
      const left = f.options('left'), right = f.options('right');
      left.callbacks.nativeId = id => { a = id; }; right.callbacks.nativeId = id => { b = id; };
      assert.deepEqual(await Promise.all([f.make().run(left), f.make().run(right)]), ['result: left', 'result: right']);
      assert.ok(a); assert.ok(b); assert.notEqual(a, b);
      assert.deepEqual(await Promise.all([
        f.make().run({ ...f.options('left resumed'), nativeId: a }),
        f.make().run({ ...f.options('right resumed'), nativeId: b }),
      ]), ['result: left resumed', 'result: right resumed']);
    } finally { await f.close(); }
  });
  test(`${provider}: forwards public progress while keeping raw reasoning out of the reply`, async () => {
    const f = setup(); try {
      const answer = await f.make().run(f.options('visible-progress'));
      assert.ok(f.state.progress.some(text => text.includes('Checking project files')));
      assert.ok(f.state.progress.some(text => text.includes('Running the relevant checks')));
      assert.ok(f.state.progress.every(text => !text.includes('PRIVATE_REASONING')));
      assert.ok(f.state.progress.every(text => !text.includes('PRIVATE_SIGNATURE')));
      if (provider === 'claude') {
        assert.ok(f.state.progress.includes('Checking the voice request'));
        assert.ok(f.state.progress.includes('Voice request summary'));
      }
      assert.equal(answer, 'result: visible-progress');
    } finally { await f.close(); }
  });
}

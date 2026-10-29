import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.ts';
import { CodexAgent } from '../src/providers/codex.ts';
import { ClaudeAgent } from '../src/providers/claude.ts';
import { JsonProcess } from '../src/providers/wire.ts';
import { Uncertain } from '../src/providers/types.ts';
import type { AgentRun } from '../src/providers/types.ts';

function protocolFixture(transform: (source: string) => string) {
  const f = fixture(), binary = join(f.dir, 'protocol-fixture.mjs');
  writeFileSync(binary, transform(readFileSync(fileURLToPath(new URL('./fixtures/agent.mjs', import.meta.url)), 'utf8')));
  chmodSync(binary, 0o700);
  const options: AgentRun = { cwd: f.dir, mode: 'ask', nativeId: null, prompt: 'task', signal: new AbortController().signal,
    callbacks: { nativeId() {}, applied() {}, progress() {}, async input() { return { allow: false }; } } };
  return { ...f, binary, options };
}

test('Ask refuses full-access sandbox before dispatching a task', async () => {
  const f = protocolFixture(s => s.replace("type: mode === 'never' ? 'dangerFullAccess' : 'workspaceWrite'", "type: 'dangerFullAccess'"));
  try {
    await assert.rejects(() => new CodexAgent(f.binary).run(f.options), /отклонила ask/);
    assert.equal(existsSync(join(f.dir, 'changed.txt')), false);
  } finally { await f.close(); }
});

test('Codex refuses a changed working directory before task dispatch', async () => {
  const f = protocolFixture(s => s.replace('cwd: process.cwd() } });\n    } else', "cwd: '/tmp' } });\n    } else"));
  try {
    await assert.rejects(() => new CodexAgent(f.binary).run(f.options), /другую рабочую директорию/);
    assert.equal(existsSync(join(f.dir, 'changed.txt')), false);
  } finally { await f.close(); }
});

test('Codex resume cannot replace a saved native session with another returned ID', async () => {
  const f = protocolFixture(s => s.replace('thread: { id: nativeId }', "thread: { id: frame.params.threadId ? 'different-thread' : nativeId }"));
  try {
    let nativeId: string | null = null;
    await new CodexAgent(f.binary).run({ ...f.options, callbacks: { ...f.options.callbacks, nativeId: id => { nativeId = id; } } });
    let assigned: string | undefined;
    await assert.rejects(() => new CodexAgent(f.binary).run({ ...f.options, nativeId, callbacks: { ...f.options.callbacks, nativeId: id => { assigned = id; } } }), /другую сессию/);
    assert.equal(assigned, undefined);
  } finally { await f.close(); }
});

test('Codex requires a compatible handshake rather than accepting an empty object', async () => {
  const f = protocolFixture(s => s.replace("userAgent: 'fake-codex'", "unknown: 'future-protocol'"));
  try {
    await assert.rejects(() => new CodexAgent(f.binary).run(f.options), /не подтвердил протокол/);
    assert.equal(existsSync(join(f.dir, 'changed.txt')), false);
  } finally { await f.close(); }
});

test('malformed task events are uncertain failures, never successful text coercions', async () => {
  const f = protocolFixture(s => s.replace("delta: 'Привет 🌍'", "delta: { invalid: 'text' }"));
  try {
    await assert.rejects(() => new CodexAgent(f.binary).run(f.options), error => error instanceof Uncertain && /формат протокола/.test(error.message));
  } finally { await f.close(); }
});

test('unknown terminal status pauses recovery instead of becoming an ordinary task failure', async () => {
  const f = protocolFixture(s => s.replace("status: prompt === 'failed' ? 'failed' : 'completed'", "status: 'unexpected-future-state'"));
  try {
    await assert.rejects(() => new CodexAgent(f.binary).run(f.options), error => error instanceof Uncertain && /формат протокола/.test(error.message));
  } finally { await f.close(); }
});

test('Claude rejects invalid result types instead of passing objects to Telegram', async () => {
  const f = protocolFixture(s => s.replace('result: `result: ${prompt}`, session_id:', "result: { invalid: 'text' }, session_id:"));
  try {
    await assert.rejects(() => new ClaudeAgent(f.binary).run(f.options), error => error instanceof Uncertain && /формат протокола/.test(error.message));
  } finally { await f.close(); }
});

test('malformed control responses reject pending requests immediately', async () => {
  const f = protocolFixture(s => s.replace("subtype: 'success', request_id: frame.request_id, response: { current_permission_mode:", "subtype: 'unknown', request_id: frame.request_id, response: { current_permission_mode:"));
  try {
    await assert.rejects(() => new ClaudeAgent(f.binary).run(f.options), /формат протокола/);
    assert.equal(existsSync(join(f.dir, 'changed.txt')), false);
  } finally { await f.close(); }
});

test('stderr provides actionable categories without echoing credentials or prompts', async () => {
  const f = fixture();
  const secret = '123:abcdefghijklmnopqrstuvwxyz PRIVATE_PROMPT sk-sensitive-secret';
  const binary = join(f.dir, 'bad-cli.mjs');
  writeFileSync(binary, `#!/usr/bin/env node\nprocess.stdin.once('data',()=>{process.stderr.write(${JSON.stringify('unknown option --permission-mode ' + secret)},()=>process.exit(2));});`); chmodSync(binary, 0o700);
  const wire = new JsonProcess(binary, [], f.dir);
  try {
    await assert.rejects(() => wire.request('initialize'), error => error instanceof Error && /не поддерживает параметры/.test(error.message) && !error.message.includes(secret) && !error.message.includes('PRIVATE_PROMPT'));
  } finally { await wire.close(); await f.close(); }
});

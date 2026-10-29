import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, chmodSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { fixture, message, route } from './helpers.ts';
import { Engine } from '../src/core.ts';
import { Store } from '../src/storage.ts';
import { CodexAgent } from '../src/providers/codex.ts';
import { ClaudeAgent } from '../src/providers/claude.ts';
import { flushOne } from '../src/runtime.ts';

test('two portable projects: inbox → real subprocess protocol → files → outbox; restart/resume', async () => {
  const left = fixture(), right = fixture();
  let reloaded: Store | undefined;
  try {
    for (const [f, provider] of [[left, 'codex'], [right, 'claude']] as const) {
      const binary = join(f.dir, 'agent'); copyFileSync(fileURLToPath(new URL('./fixtures/agent.mjs', import.meta.url)), binary); chmodSync(binary, 0o700);
      f.engine = new Engine(f.config, f.store, f.messenger, () => provider === 'codex' ? new CodexAgent(binary) : new ClaudeAgent(binary)); f.engine.available = new Set([provider]);
      f.store.set('chat', '123'); f.store.createSession(provider, 'full');
      route(f, message(1, `${provider}-first`)); f.engine.kick();
    }
    await Promise.all([left.engine.settle(), right.engine.settle()]);
    assert.equal(readFileSync(join(left.dir, 'changed.txt'), 'utf8'), 'codex-first');
    assert.equal(readFileSync(join(right.dir, 'changed.txt'), 'utf8'), 'claude-first');
    for (const f of [left, right]) {
      while (await flushOne(f.store, f.messenger, 123)) {}
      assert.ok(f.messenger.sent.some(s => s.text.includes('result:')));
      assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM jobs WHERE state='completed'").get()!.n, 1);
    }
    // A new storage connection + engine models a bridge restart. Native history
    // lives in the test agent process's persisted files, not Engine memory.
    const expectedNative = left.store.session()?.native_id;
    reloaded = new Store(left.config); assert.equal(reloaded.recover(), 0);
    const restarted = new Engine(left.config, reloaded, left.messenger, () => new CodexAgent(join(left.dir, 'agent'))); restarted.available.add('codex');
    reloaded.ingest([message(2, 'resumed')], () => true); restarted.drainInbox(); restarted.kick(); await restarted.settle();
    assert.equal(reloaded.session()?.native_id, expectedNative); assert.equal(readFileSync(join(left.dir, 'changed.txt'), 'utf8'), 'resumed');
    assert.equal(readFileSync(join(right.dir, 'changed.txt'), 'utf8'), 'claude-first');
    await restarted.stop();
  } finally { reloaded?.close(); await left.close(); await right.close(); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers.ts';
import { runtimeIdentity } from '../src/version.ts';
import { capture } from '../src/process.ts';

function installedCli() {
  const f = fixture(), source = fileURLToPath(new URL('../', import.meta.url));
  cpSync(join(source, 'src'), join(f.config.root, 'src'), { recursive: true });
  cpSync(join(source, 'package.json'), join(f.config.root, 'package.json'));
  const binary = join(f.dir, 'provider');
  writeFileSync(binary, '#!/usr/bin/env node\nconsole.log("fixture 1.0");\n'); chmodSync(binary, 0o700);
  writeFileSync(join(f.config.root, '.env'), `TELEGRAM_BOT_TOKEN=123:abcdefghijklmnopqrstuvwxyz\nTELEGRAM_USER_ID=123\nCODEX_BIN=${binary}\nCLAUDE_BIN=${binary}\nFFMPEG_BIN=${binary}\nWHISPER_BIN=${binary}\nWHISPER_MODEL_PATH=${join(f.dir, 'model')}\n`);
  return { ...f, run: (action: string, ...args: string[]) => capture(process.execPath, [join(f.config.root, 'src/cli.ts'), action, ...args], f.dir, 5000) };
}

test('identity changes with source changes, not credentials, data or root location', async () => {
  const f = installedCli();
  try {
    const before = runtimeIdentity(f.config.root), second = join(f.dir, 'another-copy'); mkdirSync(second);
    cpSync(join(f.config.root, 'src'), join(second, 'src'), { recursive: true });
    cpSync(join(f.config.root, 'package.json'), join(second, 'package.json'));
    assert.deepEqual(before, runtimeIdentity(second));
    writeFileSync(join(f.config.root, '.env'), 'SECRET=changed'); f.store.set('test', 'different');
    assert.deepEqual(runtimeIdentity(f.config.root), before);
    const file = join(f.config.root, 'src/main.ts'); writeFileSync(file, readFileSync(file, 'utf8') + '\n// changed copy\n');
    assert.notEqual(runtimeIdentity(f.config.root).revision, before.revision);
  } finally { await f.close(); }
});

test('installed doctor and version identify the source copy without exposing secrets', async () => {
  const f = installedCli();
  try {
    for (const action of ['doctor', 'version']) {
      const result = await f.run(action);
      assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /Crowl 0\.1\.0 \([a-f0-9]{12}\)/);
      assert.ok(result.stdout.includes(f.config.root)); assert.doesNotMatch(result.stdout + result.stderr, /abcdefghijklmnopqrstuvwxyz/);
    }
  } finally { await f.close(); }
});

test('installed backup keeps the old schema in both original and copied databases', async () => {
  const f = installedCli();
  try {
    f.store.db.exec('PRAGMA user_version=2');
    const result = await f.run('backup'); assert.equal(result.code, 0, result.stderr);
    assert.equal(f.store.db.prepare('PRAGMA user_version').get()!.user_version, 2);
    const saved = new DatabaseSync(result.stdout.trim(), { readOnly: true });
    try { assert.equal(saved.prepare('PRAGMA user_version').get()!.user_version, 2); } finally { saved.close(); }
  } finally { await f.close(); }
});

test('outbox inspection does not migrate, retry preserves jobs and skips expired permissions', async () => {
  const f = installedCli();
  try {
    const s = f.store.createSession('codex', 'full'), job = f.store.enqueue(1, s, 'never rerun', null);
    f.store.state(job.id, 'running'); f.store.state(job.id, 'completed', 'preserved');
    f.store.db.prepare("INSERT INTO requests VALUES ('expired',?,'permission','approve',NULL,'expired',?)").run(job.id, Date.now());
    f.store.outgoing('failed result'); f.store.outgoing('stale approval', undefined, 'expired');
    f.store.db.exec("UPDATE outbox SET failed_at=100,last_error='bad request',attempts=3; PRAGMA user_version=4");
    let result = await f.run('outbox-status'); assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /Не доставлены: 2/);
    assert.equal(f.store.db.prepare('PRAGMA user_version').get()!.user_version, 4);
    result = await f.run('outbox-retry', 'all'); assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /доставку: 1/);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox WHERE failed_at IS NOT NULL').get()!.n, 1);
    assert.equal(f.store.job(job.id)?.state, 'completed'); assert.equal(f.store.job(job.id)?.result, 'preserved');
    result = await f.run('outbox-retry', '-1'); assert.equal(result.code, 1); assert.match(result.stderr, /Использование/);
    result = await f.run('outbox-retry'); assert.equal(result.code, 1);
  } finally { await f.close(); }
});

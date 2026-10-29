import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installProject, BLANK_PROJECT_ENV } from '../src/project-setup.ts';
import { loadConfig, ROOT } from '../src/config.ts';
import { Store } from '../src/storage.ts';
import { acquireLock, serviceLabel, botLockPath } from '../src/service.ts';
import { Engine } from '../src/core.ts';
import { CodexAgent } from '../src/providers/codex.ts';
import { ClaudeAgent } from '../src/providers/claude.ts';
import { FakeMessenger, message } from './helpers.ts';
import { flushOne } from '../src/runtime.ts';

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'crowl install ')));
  const source = join(base, 'source'), project = join(base, 'Host project with spaces');
  mkdirSync(join(source, 'src'), { recursive: true }); mkdirSync(project);
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'crowl', type: 'module', scripts: { doctor: 'node src/main.ts' } }));
  writeFileSync(join(source, 'src/main.ts'), 'console.log("fixture main");\n');
  writeFileSync(join(source, 'src/config.ts'), 'export const root = "fixture";\n');
  return { base, source, project, close: () => rmSync(base, { recursive: true, force: true }) };
}

test('fresh install preserves host code and copies no source credentials, history or modules', () => {
  const f = setup(); try {
    writeFileSync(join(f.project, 'package.json'), '{"name":"host-project"}');
    writeFileSync(join(f.project, 'app.ts'), 'host source');
    writeFileSync(join(f.source, '.env'), 'TELEGRAM_BOT_TOKEN=source-secret');
    writeFileSync(join(f.source, '.env.example'), 'TELEGRAM_BOT_TOKEN=example-secret');
    for (const name of ['node_modules', '.data', '.git', '.crowl', '.cache']) {
      mkdirSync(join(f.source, name)); writeFileSync(join(f.source, name, 'private.txt'), 'private');
    }
    const result = installProject(f.project, f.source);
    assert.equal(result.root, join(f.project, '.crowl'));
    assert.equal(readFileSync(join(f.project, 'package.json'), 'utf8'), '{"name":"host-project"}');
    assert.equal(readFileSync(join(f.project, 'app.ts'), 'utf8'), 'host source');
    assert.equal(readFileSync(join(result.root, '.env'), 'utf8'), BLANK_PROJECT_ENV);
    assert.equal(readFileSync(join(result.root, '.env.example'), 'utf8'), BLANK_PROJECT_ENV);
    assert.equal(statSync(join(result.root, '.env')).mode & 0o777, 0o600);
    assert.ok(existsSync(join(result.root, 'src/main.ts')));
    for (const name of ['node_modules', '.data', '.git', '.crowl', '.cache']) assert.equal(existsSync(join(result.root, name)), false);
    assert.ok(result.nextSteps[0].includes("Host project with spaces/.crowl'"));
    assert.equal(readdirSync(f.project).some(name => name.startsWith('.crowl-install-')), false);
  } finally { f.close(); }
});

test('existing instances, empty destinations, and dangling target symlinks are never overwritten', () => {
  const f = setup(); try {
    const destination = join(f.project, '.crowl'); mkdirSync(destination);
    assert.throws(() => installProject(f.project, f.source), /уже есть/);
    writeFileSync(join(destination, '.env'), 'keep credentials');
    assert.throws(() => installProject(f.project, f.source), /уже есть/);
    assert.equal(readFileSync(join(destination, '.env'), 'utf8'), 'keep credentials');
    rmSync(destination, { recursive: true }); symlinkSync(join(f.project, 'nonexistent'), destination);
    assert.throws(() => installProject(f.project, f.source), /уже есть/);
  } finally { f.close(); }
});

test('installing inside source uses a finite manifest and never recurses into installed copies', () => {
  const f = setup(); try {
    const nested = join(f.source, 'src', 'test-host'); mkdirSync(nested);
    const result = installProject(nested, f.source);
    assert.ok(existsSync(join(result.root, 'src/main.ts')));
    assert.equal(existsSync(join(result.root, 'src/test-host/.crowl')), false);
    assert.equal(readdirSync(nested).some(name => name.startsWith('.crowl-install-')), false);
    const self = installProject(f.source, f.source);
    assert.ok(existsSync(join(self.root, 'src/main.ts')));
    assert.equal(existsSync(join(self.root, '.crowl')), false);
  } finally { f.close(); }
});

test('source symlinks are rejected before destination creation; invalid source leaves host untouched', () => {
  const f = setup(); try {
    writeFileSync(join(f.source, '.env'), 'secret'); symlinkSync(join(f.source, '.env'), join(f.source, 'src/linked.ts'));
    assert.throws(() => installProject(f.project, f.source), /символические ссылки/);
    assert.deepEqual(readdirSync(f.project), []);
    rmSync(join(f.source, 'src/linked.ts')); rmSync(join(f.source, 'src/main.ts'));
    assert.throws(() => installProject(f.project, f.source), /src\/main.ts/);
    assert.deepEqual(readdirSync(f.project), []);
  } finally { f.close(); }
});

test('invalid project paths are refused and shell instructions quote dollar/backtick/single quote safely', () => {
  const f = setup(); try {
    assert.throws(() => installProject('relative', f.source), /абсолютный/);
    writeFileSync(join(f.base, 'file'), 'not directory');
    assert.throws(() => installProject(join(f.base, 'file'), f.source), /папку/);
    const target = join(f.base, "project '$HOME`echo no`" ); mkdirSync(target);
    const result = installProject(target, f.source);
    const directory = execFileSync('/bin/sh', ['-c', `${result.nextSteps[0]} && pwd`], { encoding: 'utf8' }).trim();
    assert.equal(directory, result.root);
  } finally { f.close(); }
});

test('real installed Crowl runs doctor from another cwd without dependencies and computes host directory', () => {
  const f = setup(); try {
    const result = installProject(f.project, ROOT);
    const output = execFileSync(process.execPath, [join(result.root, 'src/cli.ts'), 'doctor'], { cwd: tmpdir(), encoding: 'utf8', timeout: 30000 });
    assert.ok(output.includes(`Проект: ${f.project}`));
    assert.equal(existsSync(join(result.root, 'node_modules')), false);
  } finally { f.close(); }
});

test('two installed projects have independent configuration, SQLite, project locks and service labels', () => {
  const f = setup(); let left: Store | undefined, right: Store | undefined;
  const releases: (() => void)[] = [];
  try {
    const second = join(f.base, 'Second host'); mkdirSync(second);
    const one = installProject(f.project, ROOT), two = installProject(second, ROOT);
    writeFileSync(join(one.root, '.env'), 'TELEGRAM_BOT_TOKEN=123:abcdefghijklmnopqrstuvwxyz\nTELEGRAM_USER_ID=123\n');
    writeFileSync(join(two.root, '.env'), 'TELEGRAM_BOT_TOKEN=456:abcdefghijklmnopqrstuvwxyz\nTELEGRAM_USER_ID=123\n');
    const firstConfig = loadConfig(one.root), secondConfig = loadConfig(two.root);
    assert.notEqual(firstConfig.token, secondConfig.token); assert.notEqual(firstConfig.project, secondConfig.project);
    left = new Store(firstConfig); right = new Store(secondConfig);
    const oneSession = left.createSession('codex', 'full'), twoSession = right.createSession('claude', 'full');
    left.enqueue(1, oneSession, 'first only', null); right.enqueue(1, twoSession, 'second only', null);
    assert.equal(left.queue()[0].text, 'first only'); assert.equal(right.queue()[0].text, 'second only');
    assert.equal(left.session(twoSession.id), undefined); assert.equal(right.session(oneSession.id), undefined);
    releases.push(acquireLock(join(firstConfig.data, 'instance-lock.sqlite')), acquireLock(join(secondConfig.data, 'instance-lock.sqlite')));
    assert.notEqual(serviceLabel(firstConfig), serviceLabel(secondConfig));
    releases.push(acquireLock(botLockPath(123, join(f.base, 'locks'))), acquireLock(botLockPath(456, join(f.base, 'locks'))));
    assert.throws(() => acquireLock(botLockPath(123, join(f.base, 'locks'))), /Другой экземпляр/);
  } finally { for (const release of releases.reverse()) release(); left?.close(); right?.close(); f.close(); }
});

test('two installed instances execute agent protocols concurrently and deliver results only to their own outbox', async () => {
  const f = setup(); const stores: Store[] = [], engines: Engine[] = [];
  try {
    const second = join(f.base, 'Second host'); mkdirSync(second);
    const hosts = [f.project, second]; const messengers = [new FakeMessenger(), new FakeMessenger()];
    for (let i = 0; i < hosts.length; i++) {
      const installed = installProject(hosts[i], ROOT);
      writeFileSync(join(installed.root, '.env'), `TELEGRAM_BOT_TOKEN=${i + 123}:abcdefghijklmnopqrstuvwxyz\nTELEGRAM_USER_ID=123\n`);
      const config = loadConfig(installed.root), binary = join(installed.root, 'tests/fixtures/agent.mjs');
      chmodSync(binary, 0o700);
      const store = new Store(config), provider = i === 0 ? 'codex' : 'claude'; stores.push(store);
      const engine = new Engine(config, store, messengers[i], () => provider === 'codex' ? new CodexAgent(binary) : new ClaudeAgent(binary));
      engines.push(engine); engine.available.add(provider); store.set('chat', '123'); store.createSession(provider, 'full');
      store.ingest([message(1, `project-${i}`)], () => true); engine.drainInbox(); engine.kick();
    }
    await Promise.all(engines.map(engine => engine.settle()));
    for (let i = 0; i < hosts.length; i++) {
      assert.equal(readFileSync(join(hosts[i], 'changed.txt'), 'utf8'), `project-${i}`);
      while (await flushOne(stores[i], messengers[i], 123)) {}
      assert.ok(messengers[i].sent.some(row => row.text.includes(`result: project-${i}`)));
      assert.ok(messengers[i].sent.every(row => !row.text.includes(`result: project-${1 - i}`)));
      assert.equal(stores[i].db.prepare("SELECT count(*) AS n FROM jobs WHERE state='completed'").get()!.n, 1);
    }
  } finally { await Promise.all(engines.map(engine => engine.stop())); for (const store of stores) store.close(); f.close(); }
});

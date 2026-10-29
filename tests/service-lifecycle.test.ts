import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, openSync, writeSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fixture } from './helpers.ts';
import { acquireLock, manageService, plist, rotateServiceLogs, servicePaths, serviceState } from '../src/service.ts';
import type { ServiceOptions } from '../src/service.ts';

function serviceFixture() {
  const f = fixture(); mkdirSync(join(f.config.root, 'src')); writeFileSync(join(f.config.root, 'src/main.ts'), '// fixture');
  writeFileSync(join(f.config.root, '.env'), 'fixture only');
  let loaded = false, running = false, failure: string | undefined;
  const calls: string[][] = [];
  const options: ServiceOptions = {
    home: join(f.dir, 'home'), platform: 'darwin', uid: 123, pollMs: 0,
    runner: async (_binary, args) => {
      calls.push(args);
      if (args[0] === 'print') return { code: loaded ? 0 : 113, stdout: loaded ? `state = ${running ? 'running' : 'waiting'}\n pid = 777\n last exit code = 0\n` : '', stderr: loaded ? '' : 'not found', wall_time_seconds: 0 };
      if (failure && args[0] === failure) return { code: 5, stdout: '', stderr: `Cannot run ${f.config.token}`, wall_time_seconds: 0 };
      if (args[0] === 'bootstrap') { loaded = true; running = true; }
      if (args[0] === 'bootout') { loaded = false; running = false; }
      if (args[0] === 'kickstart') running = true;
      return { code: 0, stdout: '', stderr: '', wall_time_seconds: 0 };
    },
  };
  return { ...f, options, calls, fail: (action: string) => { failure = action; }, waiting: () => { running = false; }, paths: servicePaths(f.config, options) };
}

test('service install/start are idempotent and report running only when launchctl confirms it', async () => {
  const f = serviceFixture(); try {
    assert.match(await manageService(f.config, 'install', f.options), /запущен/);
    assert.ok(existsSync(f.paths.file)); assert.equal(statSync(f.paths.file).mode & 0o777, 0o600);
    assert.match(await manageService(f.config, 'install', f.options), /уже работает/);
    assert.match(await manageService(f.config, 'start', f.options), /уже работает/);
    assert.equal(f.calls.filter(c => c[0] === 'bootstrap').length, 1);
    const state = await serviceState(f.config, f.options); assert.equal(state.pid, 777); assert.equal(state.running, true);
    const status = await manageService(f.config, 'status', f.options); assert.match(status, /работает \(PID 777\)/); assert.ok(!status.includes(f.config.token));
  } finally { await f.close(); }
});

test('service stop retains install, start bootstraps again, uninstall preserves application state', async () => {
  const f = serviceFixture(); try {
    await manageService(f.config, 'install', f.options); await manageService(f.config, 'stop', f.options);
    assert.ok(existsSync(f.paths.file)); assert.equal((await serviceState(f.config, f.options)).loaded, false);
    await manageService(f.config, 'start', f.options);
    await manageService(f.config, 'uninstall', f.options);
    assert.ok(!existsSync(f.paths.file)); assert.ok(existsSync(join(f.config.root, '.env'))); assert.ok(existsSync(join(f.config.data, 'crowl.sqlite')));
    assert.match(await manageService(f.config, 'uninstall', f.options), /удалён/);
  } finally { await f.close(); }
});

test('foreground/project lock prevents bootstrap and leaves LaunchAgents untouched', async () => {
  const f = serviceFixture(); const release = acquireLock(join(f.config.data, 'instance-lock.sqlite'));
  try {
    await assert.rejects(() => manageService(f.config, 'install', f.options), /уже работает в Terminal/);
    assert.equal(f.calls.filter(c => c[0] === 'bootstrap').length, 0); assert.ok(!existsSync(f.paths.file));
  } finally { release(); await f.close(); }
});

test('another project using the same bot lock cannot start a second poller', async () => {
  const f = serviceFixture(); const release = acquireLock(join(f.paths.locks, 'bot-123.sqlite'));
  try { await assert.rejects(() => manageService(f.config, 'start', f.options), /другой копии/); assert.ok(!existsSync(f.paths.file)); }
  finally { release(); await f.close(); }
});

test('failed bootstrap restores an existing plist and redacts credentials', async () => {
  const f = serviceFixture(); try {
    mkdirSync(dirname(f.paths.file), { recursive: true }); writeFileSync(f.paths.file, 'previous plist'); f.fail('bootstrap');
    await assert.rejects(() => manageService(f.config, 'install', f.options), error => error instanceof Error && error.message.includes('[TOKEN]') && !error.message.includes(f.config.token));
    assert.equal(readFileSync(f.paths.file, 'utf8'), 'previous plist');
  } finally { await f.close(); }
});

test('restart explicitly reloads the plist; start will not silently replace a live configuration', async () => {
  const f = serviceFixture(); try {
    await manageService(f.config, 'install', f.options); writeFileSync(f.paths.file, 'outdated');
    await assert.rejects(() => manageService(f.config, 'start', f.options), /service:restart/);
    await manageService(f.config, 'restart', f.options);
    assert.equal(readFileSync(f.paths.file, 'utf8'), plist(f.config));
    assert.ok(f.calls.some(c => c[0] === 'bootout')); assert.equal(f.calls.filter(c => c[0] === 'bootstrap').length, 2);
  } finally { await f.close(); }
});

test('loaded but waiting service uses kickstart; status errors never imply safe to bootstrap', async () => {
  const f = serviceFixture(); try {
    await manageService(f.config, 'install', f.options); f.waiting(); await manageService(f.config, 'start', f.options);
    assert.ok(f.calls.some(c => c[0] === 'kickstart'));
    const bad: ServiceOptions = { ...f.options, runner: async () => ({ code: 1, stdout: '', stderr: 'Not permitted', wall_time_seconds: 0 }) };
    await assert.rejects(() => manageService(f.config, 'start', bad), /проверить состояние/);
  } finally { await f.close(); }
});

test('restart waits for the previous process to release its locks after bootout', async () => {
  const f = serviceFixture(); let release: (() => void) | undefined;
  try {
    await manageService(f.config, 'install', f.options);
    writeFileSync(f.paths.file, 'outdated configuration requires reload');
    release = acquireLock(join(f.config.data, 'instance-lock.sqlite'));
    const runner = f.options.runner!;
    const options: ServiceOptions = { ...f.options, stopWaitMs: 1000, runner: async (...args) => {
      const result = await runner(...args);
      if (args[1][0] === 'bootout') setTimeout(() => { release?.(); release = undefined; }, 30);
      if (args[1][0] === 'bootstrap') assert.equal(release, undefined);
      return result;
    } };
    assert.match(await manageService(f.config, 'restart', options), /Сервис запущен/);
    assert.equal(f.calls.filter(c => c[0] === 'bootstrap').length, 2);
  } finally { release?.(); await f.close(); }
});

test('restart keeps rejecting a lock held beyond the shutdown deadline', async () => {
  const f = serviceFixture(); let release: (() => void) | undefined;
  try {
    await manageService(f.config, 'install', f.options);
    writeFileSync(f.paths.file, 'outdated configuration requires reload');
    release = acquireLock(join(f.paths.locks, 'bot-123.sqlite'));
    await assert.rejects(() => manageService(f.config, 'restart', { ...f.options, stopWaitMs: 0 }), /другой копии/);
    assert.equal(f.calls.filter(c => c[0] === 'bootstrap').length, 1);
  } finally { release?.(); await f.close(); }
});

test('ordinary restart uses launchd in place even while its process holds the project lock', async () => {
  const f = serviceFixture(); let release: (() => void) | undefined;
  try {
    await manageService(f.config, 'install', f.options);
    release = acquireLock(join(f.config.data, 'instance-lock.sqlite'));
    assert.match(await manageService(f.config, 'restart', f.options), /Сервис запущен/);
    assert.ok(f.calls.some(c => c[0] === 'kickstart' && c[1] === '-k' && c[2] === f.paths.target));
    assert.ok(!f.calls.some(c => c[0] === 'bootout'));
    assert.equal(f.calls.filter(c => c[0] === 'bootstrap').length, 1);
  } finally { release?.(); await f.close(); }
});

test('bootstrap retries transient EIO only while launchd confirms the service is absent', async () => {
  const f = serviceFixture(); let attempts = 0;
  try {
    const runner = f.options.runner!;
    const options: ServiceOptions = { ...f.options, runner: async (...args) => {
      if (args[1][0] === 'bootstrap' && ++attempts === 1) return { code: 5, stdout: '', stderr: 'Input/output error', wall_time_seconds: 0 };
      return runner(...args);
    } };
    assert.match(await manageService(f.config, 'start', options), /Сервис запущен/);
    assert.equal(attempts, 2);
  } finally { await f.close(); }
});

test('service log rotation keeps launchd open descriptors attached to active log', async () => {
  const f = fixture(); try {
    const path = join(f.config.data, 'service-error.log'); writeFileSync(path, 'x'.repeat(2_000_001));
    const fd = openSync(path, 'a');
    try { rotateServiceLogs(f.config.data); writeSync(fd, 'new event'); }
    finally { closeSync(fd); }
    assert.equal(readFileSync(path, 'utf8'), 'new event'); assert.equal(statSync(path + '.1').size, 2_000_001);
  } finally { await f.close(); }
});

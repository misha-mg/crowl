import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RuntimeLifecycle } from '../src/lifecycle.ts';
import { capture } from '../src/process.ts';

test('fatal loop aborts peers, waits for cleanup, and remains fatal after a later stop signal', async () => {
  const runtime = new RuntimeLifecycle(), failure = new Error('poll failed');
  let peerStopped = false;
  await assert.rejects(() => runtime.supervise([
    async () => { throw failure; },
    async () => new Promise<void>(resolve => runtime.shutdown.signal.addEventListener('abort', () => { peerStopped = true; resolve(); }, { once: true })),
  ]), error => error === failure);
  assert.equal(peerStopped, true);
  runtime.requestStop();
  const reported: unknown[] = [];
  assert.equal(runtime.failure(failure, error => reported.push(error)), 1);
  assert.deepEqual(reported, [failure]);
});

test('owner-requested startup cancellation is quiet and successful', () => {
  const runtime = new RuntimeLifecycle(); runtime.requestStop();
  assert.equal(runtime.failure(new Error('aborted fetch'), () => assert.fail('unexpected failure report')), 0);
});

function installedMain() {
  const dir = mkdtempSync(join(tmpdir(), 'crowl runtime test ')), root = join(dir, '.crowl'); mkdirSync(root);
  const source = fileURLToPath(new URL('../', import.meta.url));
  cpSync(join(source, 'src'), join(root, 'src'), { recursive: true });
  cpSync(join(source, 'package.json'), join(root, 'package.json'));
  const binary = join(dir, 'provider');
  writeFileSync(binary, '#!/usr/bin/env node\nconsole.log("fixture 1.0");\n'); chmodSync(binary, 0o700);
  writeFileSync(join(root, '.env'), `TELEGRAM_BOT_TOKEN=123:abcdefghijklmnopqrstuvwxyz\nTELEGRAM_USER_ID=123\nCODEX_BIN=${binary}\nCLAUDE_BIN=${binary}\nVOICE_ENABLED=false\n`);
  // Keep the real entrypoint and replace only OS/service side effects in this copy.
  writeFileSync(join(root, 'src/service.ts'), 'export const acquireLock=()=>()=>{}; export const botLockPath=()=>"unused"; export const logger=()=>()=>{}; export const rotateServiceLogs=()=>{};\n');
  return { dir, root, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('actual main reports a fatal Telegram loop error and exits nonzero', async () => {
  const f = installedMain();
  try {
    const preload = join(f.dir, 'fake-network.mjs');
    writeFileSync(preload, `globalThis.fetch=async(url)=>{const method=String(url).split('/').at(-1);return Response.json(method==='getUpdates'?{ok:false,error_code:401,description:'fixture revoked token'}:{ok:true,result:method==='getMe'?{id:123,username:'fixture'}:method==='getWebhookInfo'?{url:''}:{}})};`);
    const result = await capture(process.execPath, ['--import', preload, join(f.root, 'src/main.ts')], f.dir, 5000);
    assert.equal(result.code, 1); assert.match(result.stderr, /fixture revoked token/);
    assert.match(result.stdout, /Crowl 0\.1\.0 \([a-f0-9]{12}\)/);
    assert.doesNotMatch(result.stderr, /abcdefghijklmnopqrstuvwxyz/);
  } finally { f.close(); }
});

test('actual main exits cleanly when SIGTERM cancels startup network I/O', async () => {
  const f = installedMain();
  try {
    const preload = join(f.dir, 'slow-network.mjs');
    writeFileSync(preload, `globalThis.fetch=async(_url,options)=>new Promise((_,reject)=>{const keepAlive=setInterval(()=>{},1000);process.stdout.write('STARTUP_WAIT\\n');options.signal.addEventListener('abort',()=>{clearInterval(keepAlive);reject(new Error('fixture startup aborted'))},{once:true})});`);
    const child = spawn(process.execPath, ['--import', preload, join(f.root, 'src/main.ts')], { cwd: f.dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.stdout.on('data', data => { stdout += String(data); if (stdout.includes('STARTUP_WAIT')) child.kill('SIGTERM'); });
    child.stderr.on('data', data => { stderr += String(data); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    clearTimeout(deadline);
    assert.equal(code, 0); assert.match(stdout, /STARTUP_WAIT/); assert.doesNotMatch(stderr, /fixture startup aborted/);
  } finally { f.close(); }
});

for (const method of ['ingest', 'pollingOffset']) test(`actual main treats ${method} storage failure as fatal, not a network retry`, async () => {
  const f = installedMain();
  try {
    const preload = join(f.dir, 'failed-storage.mjs');
    writeFileSync(preload, `import {Store} from ${JSON.stringify(pathToFileURL(join(f.root, 'src/storage.ts')).href)};
Store.prototype.${method}=()=>{throw new Error('fixture disk failure')};
globalThis.fetch=async(url)=>{const method=String(url).split('/').at(-1);return Response.json({ok:true,result:method==='getMe'?{id:123,username:'fixture'}:method==='getWebhookInfo'?{url:''}:method==='getUpdates'?[{update_id:1,message:{message_id:1,from:{id:123},chat:{id:123,type:'private'},text:'/start'}}]:{}})};`);
    const result = await capture(process.execPath, ['--import', preload, join(f.root, 'src/main.ts')], f.dir, 5000);
    assert.equal(result.code, 1); assert.match(result.stderr, /fixture disk failure/);
  } finally { f.close(); }
});

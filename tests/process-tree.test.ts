import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, terminate, sleep } from '../src/process.ts';

for (const parentExits of [false, true]) {
  test(`termination kills a TERM-resistant tool after leader ${parentExits ? 'already exited' : 'exits on TERM'}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crowl-tree-')), heartbeat = join(dir, 'heartbeat');
    const tool = `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync(${JSON.stringify(heartbeat)},'ready'); setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),20); setTimeout(()=>process.exit(),10000); process.send('ready');`;
    const parent = `const {spawn}=require('node:child_process'); const tool=spawn(process.execPath,['-e',${JSON.stringify(tool)}],{stdio:['ignore','ignore','ignore','ipc']}); tool.once('message',()=>{console.log('ready'); ${parentExits ? 'process.exit(0)' : 'setInterval(()=>{},1000)'};});`;
    const child = launch(process.execPath, ['-e', parent], dir);
    child.stderr.resume(); child.stdin.on('error', () => {});
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Tree did not start')), 3000);
        child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
      });
      if (parentExits && child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
      const stopping = terminate(child, 100);
      assert.equal(terminate(child, 100), stopping, 'concurrent termination shares one operation');
      await stopping;
      const afterStop = readFileSync(heartbeat, 'utf8');
      await sleep(150);
      assert.equal(readFileSync(heartbeat, 'utf8'), afterStop, 'tool must stop writing after terminate resolves');
      assert.equal(terminate(child), stopping, 'repeated termination cannot signal a recycled PID');
    } finally {
      await terminate(child, 0);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('termination of an already reaped group does not send signals', async t => {
  const child = launch(process.execPath, ['-e', ''], process.cwd());
  child.stdout.resume(); child.stderr.resume();
  await new Promise(resolve => child.once('close', resolve));
  const signal = t.mock.method(process, 'kill', () => { throw new Error('Retired group was signalled'); });
  await terminate(child);
  assert.equal(signal.mock.callCount(), 0);
});

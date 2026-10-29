import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, chmodSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, FakeMessenger } from './helpers.ts';
import { loadConfig } from '../src/config.ts';
import { plist, serviceLabel, botLockPath } from '../src/service.ts';
import { transcribe } from '../src/voice.ts';

test('project is derived from package path, .env wins, invalid configuration rejected', async () => {
  const f = fixture(); try {
    writeFileSync(join(f.config.root, '.env'), 'TELEGRAM_BOT_TOKEN=123:abcdefghijklmnopqrstuvwxyz\nTELEGRAM_USER_ID=123\nDEFAULT_PERMISSION_MODE=ask\nVOICE_ENABLED=false\n');
    const config = loadConfig(f.config.root); assert.equal(config.project, f.dir); assert.equal(config.mode, 'ask'); assert.equal(config.voice, false);
    writeFileSync(join(f.config.root, '.env'), 'TELEGRAM_USER_ID=@username'); assert.throws(() => loadConfig(f.config.root), /числовой/);
    writeFileSync(join(f.config.root, '.env'), 'DEFAULT_PERMISSION_MODE=typo'); assert.throws(() => loadConfig(f.config.root, false), /full или ask/);
  } finally { await f.close(); }
});
test('LaunchAgent uses absolute paths, escapes XML, and never embeds bot token', async () => {
  const f = fixture(); try {
    const config = { ...f.config, root: '/tmp/project <A> & B/.crowl' };
    const value = plist(config, '/opt/node bin/node');
    assert.ok(value.includes('/opt/node bin/node')); assert.ok(value.includes('&lt;A&gt; &amp; B')); assert.ok(!value.includes(f.config.token)); assert.ok(!value.includes('TELEGRAM_BOT_TOKEN'));
    assert.notEqual(serviceLabel(config), serviceLabel(f.config)); assert.equal(botLockPath(123, '/tmp'), '/tmp/bot-123.sqlite');
    assert.ok(value.includes('<key>KeepAlive</key><true/>'));
  } finally { await f.close(); }
});
test('voice pipeline passes files as argv, returns transcript and removes all temporary audio', async () => {
  const f = fixture(); try {
    const binary = join(f.dir, 'audio tool with spaces');
    writeFileSync(binary, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nconst a=process.argv.slice(2);\nif(a.includes('-otxt'))writeFileSync(a[a.indexOf('-of')+1]+'.txt',' Исправь API авторизацию ');\nelse writeFileSync(a.at(-1),'wav');\n`); chmodSync(binary, 0o700);
    const model = join(f.dir, 'model.bin'); writeFileSync(model, 'test model');
    const messenger = new FakeMessenger();
    assert.equal(await transcribe({ ...f.config, ffmpeg: binary, whisper: binary, model }, messenger, { file_id: 'x', duration: 2 }, new AbortController().signal), 'Исправь API авторизацию');
    assert.equal(messenger.downloads, 1); assert.deepEqual(readdirSync(join(f.config.data, 'audio')), []);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(() => transcribe({ ...f.config, model }, messenger, { file_id: 'x', duration: 2 }, abort.signal), /прервано/);
    assert.deepEqual(readdirSync(join(f.config.data, 'audio')), []);
  } finally { await f.close(); }
});
test('voice limits are checked before any Telegram download', async () => {
  const f = fixture(); try {
    await assert.rejects(() => transcribe(f.config, f.messenger, { file_id: 'x', duration: 301 }, new AbortController().signal), /максимум/);
    assert.equal(f.messenger.downloads, 0);
  } finally { await f.close(); }
});

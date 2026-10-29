import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, FakeMessenger, until } from './helpers.ts';
import { transcribe, voiceReadiness } from '../src/voice.ts';
import { downloadBaseModel, setupVoice } from '../src/voice-setup.ts';

function audioFixture() {
  const f = fixture();
  const tool = join(f.dir, 'audio tool');
  writeFileSync(tool, `#!/usr/bin/env node
import {writeFileSync,appendFileSync} from 'node:fs';
const a=process.argv.slice(2);
appendFileSync(${JSON.stringify(join(f.dir, 'audio-args.txt'))},JSON.stringify(a)+'\\n');
if(a.includes('-otxt'))writeFileSync(a[a.indexOf('-of')+1]+'.txt','Исправь API авторизацию');
else writeFileSync(a.at(-1),'wav');
`); chmodSync(tool, 0o700);
  const model = join(f.dir, 'model.bin'); writeFileSync(model, Buffer.from('lmggfixture'));
  return { ...f, tool, config: { ...f.config, ffmpeg: tool, whisper: tool, model } };
}
const voice = { file_id: 'voice-id', duration: 2, file_size: 100 };

test('voice readiness diagnoses missing tools and empty model before downloading', async () => {
  const f = fixture(); try {
    const readiness = voiceReadiness(f.config);
    assert.equal(readiness.ready, false); assert.equal(readiness.missing.length, 3);
    await assert.rejects(() => transcribe(f.config, f.messenger, voice, new AbortController().signal), /voice:setup/);
    assert.equal(f.messenger.downloads, 0);
    writeFileSync(f.config.model, ''); assert.ok(voiceReadiness(f.config).missing.includes('модель Whisper'));
  } finally { await f.close(); }
});
test('voice passes bounded conversion and multilingual decoding flags, removes audio', async () => {
  const f = audioFixture(); try {
    assert.equal(voiceReadiness(f.config).ready, true);
    assert.equal(await transcribe(f.config, f.messenger, voice, new AbortController().signal), 'Исправь API авторизацию');
    const args = readFileSync(join(f.dir, 'audio-args.txt'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(args[0].includes('-nostdin')); assert.ok(args[0].includes('16000')); assert.ok(args[0].includes('pcm_s16le'));
    assert.ok(args[1].includes('auto')); assert.ok(args[1].includes('-nf')); assert.ok(args[1].includes('-sns'));
    assert.deepEqual(readdirSync(join(f.config.data, 'audio')), []);
  } finally { await f.close(); }
});
test('voice rejects malformed metadata and overlarge bytes before processing', async () => {
  const f = audioFixture(); try {
    for (const invalid of [{ ...voice, duration: NaN }, { ...voice, duration: -1 }, { ...voice, file_size: -1 }, { ...voice, file_id: '' }]) {
      await assert.rejects(() => transcribe(f.config, f.messenger, invalid, new AbortController().signal));
    }
    assert.equal(f.messenger.downloads, 0);
    f.messenger.download = async () => new Uint8Array(20_000_001);
    await assert.rejects(() => transcribe(f.config, f.messenger, voice, new AbortController().signal), /превышает/);
    assert.deepEqual(readdirSync(join(f.config.data, 'audio')), []);
  } finally { await f.close(); }
});
test('empty recognition fails instead of returning an empty agent prompt', async () => {
  const f = audioFixture(); try {
    const whisper = join(f.dir, 'empty-whisper');
    writeFileSync(whisper, `#!/usr/bin/env node
import{writeFileSync}from'node:fs';const a=process.argv.slice(2);writeFileSync(a[a.indexOf('-of')+1]+'.txt','   ');`); chmodSync(whisper, 0o700);
    await assert.rejects(() => transcribe({ ...f.config, whisper }, f.messenger, voice, new AbortController().signal), /не распознал/);
    assert.deepEqual(readdirSync(join(f.config.data, 'audio')), []);
  } finally { await f.close(); }
});
test('concurrent voice requests serialize, a cancelled queued voice does not block successors', async () => {
  const f = audioFixture(); try {
    const slow = join(f.dir, 'slow-conversion');
    writeFileSync(slow, `#!/usr/bin/env node
import{writeFileSync}from'node:fs';setTimeout(()=>writeFileSync(process.argv.at(-1),'wav'),180);`); chmodSync(slow, 0o700);
    const first = transcribe({ ...f.config, ffmpeg: slow }, f.messenger, voice, new AbortController().signal);
    await until(() => f.messenger.downloads === 1);
    const cancel = new AbortController();
    const second = transcribe(f.config, f.messenger, voice, cancel.signal); const rejected = assert.rejects(() => second, /прервано/);
    const third = transcribe(f.config, f.messenger, voice, new AbortController().signal);
    cancel.abort(); await rejected; assert.equal(f.messenger.downloads, 1);
    assert.equal(await first, 'Исправь API авторизацию'); assert.equal(await third, 'Исправь API авторизацию');
    assert.equal(f.messenger.downloads, 2); assert.deepEqual(readdirSync(join(f.config.data, 'audio')), []);
  } finally { await f.close(); }
});
test('active cancellation terminates Whisper before cleanup and releases its lane', async () => {
  const f = audioFixture(); try {
    const started = join(f.dir, 'started'), leaked = join(f.dir, 'leaked'); const slow = join(f.dir, 'slow-whisper');
    writeFileSync(slow, `#!/usr/bin/env node
import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(started)},'started');setTimeout(()=>writeFileSync(${JSON.stringify(leaked)},'leaked'),350);`); chmodSync(slow, 0o700);
    const cancel = new AbortController(); const active = transcribe({ ...f.config, whisper: slow }, f.messenger, voice, cancel.signal);
    const rejected = assert.rejects(() => active, /прервано/); await until(() => existsSync(started)); cancel.abort(); await rejected;
    assert.deepEqual(readdirSync(join(f.config.data, 'audio')), []);
    assert.equal(await transcribe(f.config, f.messenger, voice, new AbortController().signal), 'Исправь API авторизацию');
    await new Promise(resolve => setTimeout(resolve, 400)); assert.equal(existsSync(leaked), false);
  } finally { await f.close(); }
});
test('model download validates checksum and atomically installs a complete GGML file', async () => {
  const f = fixture(); try {
    const target = join(f.dir, 'download.bin'), payload = Buffer.from('lmggfixture-model');
    await downloadBaseModel(target, { fetcher: (async () => new Response(payload)) as typeof fetch, expectedSha1: createHash('sha1').update(payload).digest('hex') });
    assert.deepEqual(readFileSync(target), payload); assert.ok(!readdirSync(f.dir).some(name => name.includes('.download-')));
  } finally { await f.close(); }
});
test('failed model download preserves existing model and removes partial file', async () => {
  const f = fixture(); try {
    const target = join(f.dir, 'download.bin'); writeFileSync(target, 'original');
    await assert.rejects(() => downloadBaseModel(target, { fetcher: (async () => new Response('corrupt')) as typeof fetch }), /Контрольная сумма/);
    assert.equal(readFileSync(target, 'utf8'), 'original'); assert.ok(!readdirSync(f.dir).some(name => name.includes('.download-')));
    await assert.rejects(() => downloadBaseModel(target, { fetcher: (async () => new Response(new Uint8Array(100))) as typeof fetch, maxBytes: 50 }), /превышает/);
    assert.equal(readFileSync(target, 'utf8'), 'original');
  } finally { await f.close(); }
});
test('model download honors already-aborted setup without network access', async () => {
  const f = fixture(); try {
    const abort = new AbortController(); abort.abort(); let requested = false;
    await assert.rejects(() => downloadBaseModel(join(f.dir, 'model'), { signal: abort.signal, fetcher: (async () => { requested = true; return new Response(); }) as typeof fetch }));
    assert.equal(requested, false);
  } finally { await f.close(); }
});
test('setup reuses a custom valid model and tools without requiring Homebrew or network', async () => {
  const f = audioFixture(); try {
    const calls: string[][] = [], logs: string[] = [];
    const ready = await setupVoice(f.config, { log: text => logs.push(text), fetcher: (async () => { throw new Error('unexpected download'); }) as typeof fetch,
      run: async (_binary, args) => { calls.push(args); return { code: 0, stdout: 'opus pcm_s16le ogg wav', stderr: '' }; },
    });
    assert.equal(ready.ready, true); assert.equal(calls.length, 4); assert.ok(!calls.some(args => args.includes('install')));
    assert.ok(logs.some(text => text.includes('существующую модель')));
  } finally { await f.close(); }
});
test('setup rejects a video-only FFmpeg before attempting a model download', async () => {
  const f = audioFixture(); try {
    let downloaded = false;
    await assert.rejects(() => setupVoice(f.config, { log: () => {}, run: async () => ({ code: 0, stdout: 'vp8 png', stderr: '' }), fetcher: (async () => { downloaded = true; return new Response(); }) as typeof fetch }), /Opus/);
    assert.equal(downloaded, false);
  } finally { await f.close(); }
});

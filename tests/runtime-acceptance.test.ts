import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { capture } from '../src/process.ts';

test('actual main delivers a polled task and resumes the same database without replay after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crowl acceptance ')), root = join(dir, '.crowl'); mkdirSync(root);
  const source = fileURLToPath(new URL('../', import.meta.url));
  cpSync(join(source, 'src'), join(root, 'src'), { recursive: true });
  cpSync(join(source, 'package.json'), join(root, 'package.json'));
  const agent = join(dir, 'fixture-agent.mjs');
  cpSync(join(source, 'tests/fixtures/agent.mjs'), agent); chmodSync(agent, 0o700);
  writeFileSync(join(root, '.env'), `TELEGRAM_BOT_TOKEN=123:abcdefghijklmnopqrstuvwxyz\nTELEGRAM_USER_ID=123\nCODEX_BIN=${agent}\nCLAUDE_BIN=${join(dir, 'missing-claude')}\nVOICE_ENABLED=false\nMAX_CONCURRENT_SESSIONS=1\n`);
  // Exercise the real locks; only relocate the global bot lock into this fixture.
  const service = join(root, 'src/service.ts');
  const original = readFileSync(service, 'utf8');
  const isolated = original.replace("base = join(homedir(), 'Library/Caches/crowl/locks')", `base = ${JSON.stringify(join(dir, 'locks'))}`);
  assert.notEqual(isolated, original); writeFileSync(service, isolated);
  const transcript = join(dir, 'telegram.jsonl');
  const makePreload = (restart: boolean) => {
    const path = join(dir, restart ? 'restart-network.mjs' : 'first-network.mjs');
    writeFileSync(path, `import {appendFileSync} from 'node:fs';
const restart=${JSON.stringify(restart)};
const message=(id,text)=>({update_id:id,message:{message_id:id,from:{id:123},chat:{id:123,type:'private'},text}});
const queue=restart?[message(3,'acceptance-task'),message(4,'/info')]:[message(1,'/start')];
let nextMessage=restart?1000:500;
const delay=signal=>new Promise(resolve=>{let timer;const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve()};timer=setTimeout(done,10);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done()});
globalThis.fetch=async(url,options)=>{
 const method=String(url).split('/').at(-1), params=JSON.parse(options.body);
 let result={};
 if(method==='getMe')result={id:123,username:'acceptance'};
 else if(method==='getWebhookInfo')result={url:''};
 else if(method==='getUpdates'){if(!queue.length)await delay(options.signal);result=queue.splice(0)}
 else if(method==='sendMessage'||method==='editMessageText'){
  appendFileSync(${JSON.stringify(transcript)},JSON.stringify({restart,text:params.text})+'\\n');
  result={message_id:params.message_id??++nextMessage};
  const chooser=params.reply_markup?.inline_keyboard?.flat().find(button=>button.callback_data?.startsWith('new:codex:'));
  if(!restart&&chooser)queue.push({update_id:2,callback_query:{id:'choose',from:{id:123},data:chooser.callback_data,message:{message_id:nextMessage,chat:{id:123,type:'private'}}}});
  else if(!restart&&params.text.startsWith('Сессия '))queue.push(message(3,'acceptance-task'));
  if((!restart&&params.text==='result: acceptance-task')||(restart&&params.text.startsWith('Проект:'))){setTimeout(()=>process.kill(process.pid,'SIGTERM'),30)}
 }
 return Response.json({ok:true,result});
};`);
    return path;
  };
  try {
    for (const restart of [false, true]) {
      const result = await capture(process.execPath, ['--import', makePreload(restart), join(root, 'src/main.ts')], dir, 8000);
      assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /@acceptance/);
      assert.doesNotMatch(result.stdout + result.stderr, /abcdefghijklmnopqrstuvwxyz/);
      const db = new DatabaseSync(join(root, '.data/crowl.sqlite'), { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT count(*) n FROM jobs').get()!.n, 1);
        assert.deepEqual({ ...db.prepare('SELECT state,result FROM jobs').get() }, { state: 'completed', result: 'result: acceptance-task' });
        assert.equal(db.prepare("SELECT count(*) n FROM events WHERE type='run.completed'").get()!.n, 1);
        assert.equal(db.prepare('SELECT count(*) n FROM outbox WHERE sent=0').get()!.n, 0);
      } finally { db.close(); }
    }
    assert.equal(readFileSync(join(dir, 'changed.txt'), 'utf8'), 'acceptance-task');
    const sent = readFileSync(transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(sent.filter(row => row.text === 'result: acceptance-task').length, 1);
    assert.ok(sent.some(row => row.restart && row.text.startsWith('Проект:')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

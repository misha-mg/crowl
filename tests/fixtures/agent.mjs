#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const codex = process.argv.includes('app-server');
if (!codex && process.argv.includes('--print') && process.argv[process.argv.indexOf('--thinking-display') + 1] !== 'summarized') throw new Error('Missing summarized thinking display');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let prompt = '', nativeId = '', mode = '', pending, initialized = false;
let state = 'idle', summaryApplied = false;
const nativeFile = id => join(process.cwd(), `${codex ? 'codex' : 'claude'}-native-${encodeURIComponent(id)}.json`);
function result() {
  writeFileSync(join(process.cwd(), 'changed.txt'), prompt);
  if (codex) {
    send({ method: 'thread/tokenUsage/updated', params: { threadId: nativeId, turnId: 'turn-1', tokenUsage: { total: { inputTokens: 1200, outputTokens: 300 }, last: { totalTokens: 500 }, modelContextWindow: 10000 } } });
    send({ method: 'item/agentMessage/delta', params: { threadId: nativeId, delta: 'Привет 🌍' } });
    send({ method: 'item/completed', params: { threadId: nativeId, item: { type: 'agentMessage', text: `result: ${prompt}` } } });
    send({ method: 'turn/completed', params: { threadId: nativeId, turn: { id: 'turn-1', status: prompt === 'failed' ? 'failed' : 'completed', error: { message: 'explicit failure' } } } });
  } else {
    send({ type: 'assistant', message: { model: 'claude-fixture', usage: { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 }, content: [] } });
    send({ type: 'stream_event', event: { delta: { type: 'thinking_delta', thinking: 'PRIVATE_REASONING' } } });
    send({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Привет 🌍' } } });
    send({ type: 'result', subtype: 'success', is_error: prompt === 'failed', result: `result: ${prompt}`, session_id: nativeId, usage: { input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 50, output_tokens: 75 }, modelUsage: { 'claude-fixture': { contextWindow: 10000 } } });
    state = 'idle'; send({ type: 'system', subtype: 'session_state_changed', state, sdk_host_only: true });
  }
}
function turn() {
  if (prompt === 'visible-progress') {
    if (codex) {
      send({ method: 'item/reasoning/textDelta', params: { threadId: nativeId, itemId: 'reasoning', delta: 'PRIVATE_REASONING' } });
      send({ method: 'item/reasoning/summaryTextDelta', params: { threadId: nativeId, itemId: 'reasoning', summaryIndex: 0, delta: 'Checking ' } });
      send({ method: 'item/reasoning/summaryTextDelta', params: { threadId: nativeId, itemId: 'reasoning', summaryIndex: 0, delta: 'project files' } });
      send({ method: 'item/completed', params: { threadId: nativeId, item: { type: 'reasoning', id: 'reasoning', summary: ['Checking project files'], content: ['PRIVATE_REASONING'] } } });
      send({ method: 'item/completed', params: { threadId: nativeId, item: { type: 'agentMessage', phase: 'commentary', text: 'Running the relevant checks' } } });
    } else {
      send({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking', thinking: '' } } });
      send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Checking ' } } });
      send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'the voice request' } } });
      send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'PRIVATE_SIGNATURE' } } });
      send({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Voice request summary', signature: 'PRIVATE_SIGNATURE' }, { type: 'redacted_thinking', data: 'PRIVATE_REASONING' }] } });
      send({ type: 'system', subtype: 'task_progress', description: 'Checking project files' });
      send({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } } });
      send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Running the relevant checks' }] } });
    }
    result(); return;
  }
  if (prompt === 'crash') process.exit(7);
  if (prompt === 'broken-json') { process.stdout.write('{"broken\n'); return; }
  if (prompt === 'pause') return;
  if (prompt === 'approval' || prompt === 'cancel') {
    pending = 'approval';
    send(codex ? { id: 'server-approval', method: 'item/commandExecution/requestApproval', params: { threadId: nativeId, turnId: 'turn-1', command: 'touch changed.txt', cwd: process.cwd() } }
      : { type: 'control_request', request_id: 'server-approval', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch changed.txt' } } });
    if (prompt === 'cancel') setTimeout(() => {
      send(codex ? { method: 'serverRequest/resolved', params: { threadId: nativeId, requestId: 'server-approval' } } : { type: 'control_cancel_request', request_id: 'server-approval' });
      result();
    }, 30);
  } else if (prompt === 'question') {
    pending = 'question';
    send(codex ? { id: 'server-question', method: 'item/tool/requestUserInput', params: { threadId: nativeId, turnId: 'turn-1', questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], isSecret: false }] } }
      : { type: 'control_request', request_id: 'server-question', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] } } });
  } else result();
}
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (codex) {
    if (frame.method === 'initialize') { initialized = true; send({ id: frame.id, result: { userAgent: 'fake-codex' } }); }
    else if (frame.method === 'thread/start' || frame.method === 'thread/resume') {
      if (!initialized) throw new Error('Missing init');
      if (frame.method === 'thread/resume' && (!existsSync(nativeFile(frame.params.threadId)) || JSON.parse(readFileSync(nativeFile(frame.params.threadId))).id !== frame.params.threadId)) { send({ id: frame.id, error: { message: 'Unknown exact thread ID' } }); return; }
      nativeId = frame.params.threadId || `codex-${randomUUID()}`; mode = frame.params.approvalPolicy;
      writeFileSync(nativeFile(nativeId), JSON.stringify({ id: nativeId }));
      send({ id: frame.id, result: { thread: { id: nativeId }, model: 'codex-fixture', approvalPolicy: mode, sandbox: { type: mode === 'never' ? 'dangerFullAccess' : 'workspaceWrite' }, cwd: process.cwd() } });
    } else if (frame.method === 'turn/start') {
      if (frame.params.summary !== 'auto') throw new Error('Crowl did not enable public reasoning summaries');
      prompt = frame.params.input[0].text;
      if (frame.params.threadId !== nativeId) throw new Error('Wrong thread');
      send({ id: frame.id, result: { turn: { id: 'turn-1' } } });
      send({ method: 'turn/started', params: { threadId: nativeId, turn: { id: 'turn-1' } } }); turn();
    } else if (frame.method === 'turn/interrupt') {
      send({ id: frame.id, result: {} }); send({ method: 'turn/completed', params: { threadId: nativeId, turn: { id: 'turn-1', status: 'interrupted' } } });
    } else if (frame.id === 'server-approval' || frame.id === 'server-question') {
      if (pending === 'approval') prompt = frame.result.decision === 'accept' ? 'approved' : 'denied';
      else prompt = frame.result.answers.q.answers[0]; result();
    }
  } else {
    if (frame.type === 'control_request') {
      if (frame.request.subtype === 'initialize') { initialized = true; send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { current_permission_mode: 'manual', capabilities: {} } } }); }
      else if (frame.request.subtype === 'set_max_thinking_tokens') {
        if (frame.request.thinking_display !== 'summarized' || 'max_thinking_tokens' in frame.request) throw new Error('Thinking summary setting must not change the thinking budget');
        summaryApplied = true;
        send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
      }
      else if (frame.request.subtype === 'set_permission_mode') { mode = frame.request.mode; send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } }); }
      else if (frame.request.subtype === 'interrupt') { send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } }); }
    } else if (frame.type === 'user') {
      if (!initialized || !mode || !summaryApplied) throw new Error('Missing initialization/mode/summary display');
      const resume = process.argv.find(a => a.startsWith('--resume='))?.slice(9);
      if (resume && (!existsSync(nativeFile(resume)) || JSON.parse(readFileSync(nativeFile(resume))).id !== resume)) { send({ type: 'result', subtype: 'error', is_error: true, result: 'Wrong resume ID' }); return; }
      nativeId = resume || process.argv.find(a => a.startsWith('--session-id='))?.slice(13);
      writeFileSync(nativeFile(nativeId), JSON.stringify({ id: nativeId }));
      send({ type: 'system', subtype: 'init', session_id: nativeId, permissionMode: mode });
      state = 'running'; send({ type: 'system', subtype: 'session_state_changed', state });
      prompt = frame.message.content; turn();
    } else if (frame.type === 'control_response') {
      const reply = frame.response.response;
      if (pending === 'approval') prompt = reply.behavior === 'allow' ? 'approved' : 'denied';
      else prompt = reply.updatedInput.answers['Which?']; result();
    }
  }
});

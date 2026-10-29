import { mkdtempSync, realpathSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.ts';
import { CodexAgent } from '../src/providers/codex.ts';
import { ClaudeAgent } from '../src/providers/claude.ts';
import type { AgentRun } from '../src/providers/types.ts';
import { errorText } from '../src/process.ts';

// Explicit local live test. Uses the user's existing CLI account, never prints
// credentials, only asks the model to change a fresh temporary fixture project.
const config = loadConfig(undefined, false);
const selected = process.argv[2];
if (!['claude', 'codex'].includes(selected)) throw new Error('Usage: npm run smoke -- claude|codex');
const provider = selected as 'claude' | 'codex';
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'crowl live smoke ')));
const marker = randomUUID(), controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 45_000);
let nativeId: string | null = null;
const create = () => provider === 'codex' ? new CodexAgent(config.codex) : new ClaudeAgent(config.claude);
const run = (prompt: string): AgentRun => ({ cwd: dir, mode: 'full', nativeId, prompt, signal: controller.signal, callbacks: {
  nativeId: id => { nativeId = id; }, applied: mode => console.log('Applied:', mode), progress: () => {},
  input: async () => ({ allow: false, answers: {} }),
} });
try {
  await create().run(run(`This is an isolated Crowl integration test. Use only local file tools, no external services, plugins or messaging. Write exactly ${marker} to the file crowl-smoke.txt in the current working directory. Remember this marker. Reply DONE. Do not touch any other files.`));
  if (!nativeId || !existsSync(join(dir, 'crowl-smoke.txt')) || readFileSync(join(dir, 'crowl-smoke.txt'), 'utf8').trim() !== marker) throw new Error('First turn did not create the expected fixture.');
  const answer = await create().run(run('Without reading any file or using any tools, repeat the marker from my previous prompt.'));
  if (!answer.includes(marker)) throw new Error('Resumed context did not contain the marker.');
  console.log(`${provider}: live file change + fresh process resume OK.`);
} catch (error) { console.error(`${provider}: live smoke FAILED: ${errorText(error)}`); process.exitCode = 1; }
finally { clearTimeout(timer); controller.abort(); rmSync(dir, { recursive: true, force: true }); }

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capture } from '../src/process.ts';

test('startup capture aborts a stalled subprocess without waiting for its timeout', async () => {
  const controller = new AbortController(), started = Date.now();
  const pending = capture(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.cwd(), 8000, controller.signal);
  const timer = setTimeout(() => controller.abort(), 50);
  try { await assert.rejects(() => pending, /отменена/); assert.ok(Date.now() - started < 3000); }
  finally { clearTimeout(timer); }
});
test('already aborted startup does not spawn another provider probe', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => capture('/does-not-exist', [], process.cwd(), 8000, controller.signal), /abort/i);
});

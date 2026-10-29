import { loadConfig } from '../src/config.ts';
import { JsonProcess } from '../src/providers/wire.ts';
import { capture, errorText } from '../src/process.ts';

// No inference, no auth material printed, and no project mutation.
const config = loadConfig(undefined, false);
for (const provider of ['codex', 'claude'] as const) {
  let wire: JsonProcess | undefined;
  try {
    const version = await capture(config[provider], ['--version'], config.root);
    console.log(provider, version.stdout.trim());
    wire = new JsonProcess(config[provider], provider === 'codex' ? ['app-server', '--listen', 'stdio://'] : ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--safe-mode', '--allow-dangerously-skip-permissions'], config.root);
    const result = provider === 'codex'
      ? await wire.request('initialize', { clientInfo: { name: 'crowl_probe', version: '0.1.0' }, capabilities: { experimentalApi: true } }, false, 10_000)
      : await wire.request('initialize', { hooks: null }, true, 10_000);
    console.log(provider, 'handshake OK', Object.keys(result));
    if (provider === 'claude') {
      for (const mode of ['manual', 'bypassPermissions']) {
        await wire.request('set_permission_mode', { mode }, true, 5000);
        console.log(provider, 'mode accepted:', mode);
      }
    }
  } catch (error) { console.log(provider, 'handshake FAILED:', errorText(error)); process.exitCode = 1; }
  finally { await wire?.close(); }
}

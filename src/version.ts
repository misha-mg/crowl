import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Identifies source copies without reading credentials, state or dependencies. */
export function runtimeIdentity(root: string): { version: string; revision: string } {
  const manifest = readFileSync(join(root, 'package.json'), 'utf8');
  const version: unknown = JSON.parse(manifest).version;
  const hash = createHash('sha256');
  hash.update('package.json\0').update(manifest).update('\0');
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.(?:ts|js|mjs)$/.test(entry.name)) hash.update(file + '\0').update(readFileSync(join(root, file))).update('\0');
    }
  };
  visit('src');
  return { version: typeof version === 'string' ? version : 'unknown', revision: hash.digest('hex').slice(0, 12) };
}

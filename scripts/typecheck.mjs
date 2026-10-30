// npm errors on --workspaces when none exist yet. Discover workspaces so this
// also works while the parallel agents are building them.
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
for (const parent of ['apps', 'packages']) {
  if (!existsSync(parent)) continue;
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    const path = join(parent, entry.name);
    if (!entry.isDirectory() || !existsSync(join(path, 'package.json'))) continue;
    const result = spawnSync(npm, ['run', 'typecheck', '--workspace', path, '--if-present'], { stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.error || result.status !== 0) {
      if (result.error) console.error(result.error);
      process.exit(result.status ?? 1);
    }
  }
}
const result = spawnSync(npm, ['exec', '--', 'tsc', '--noEmit', '-p', 'scripts/tsconfig.json'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error) console.error(result.error);
process.exit(result.status ?? 1);

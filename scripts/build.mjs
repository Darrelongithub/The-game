import { spawnSync } from 'node:child_process';

// Set the telemetry default before Next starts, not just before the server.
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['run', 'build', '--workspace', 'apps/web'], {
    stdio: 'inherit',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: process.env.NEXT_TELEMETRY_DISABLED ?? '1' },
    shell: process.platform === 'win32',
  });
if (result.error) console.error(result.error);
process.exit(result.status ?? 1);

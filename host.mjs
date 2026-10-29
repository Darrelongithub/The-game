import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    process.env[match[1]] = value;
  }
}
process.env.NEXT_TELEMETRY_DISABLED ??= '1';
if (!existsSync(join(root, 'apps/web/out/index.html'))) {
  console.error('web not built — run `npm run host`');
  process.exit(1);
}

// A separate process group ensures npm, its shell, and the server all receive
// the signal, rather than leaving a grandchild listening after Ctrl+C.
const windows = process.platform === 'win32';
const child = spawn(windows ? 'npx.cmd' : 'npx', ['tsx', 'apps/server/src/index.ts'], {
  cwd: root, env: process.env, stdio: 'inherit', detached: !windows, shell: windows,
});
let stopping = false;
let killTimer;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (!child.pid) return;
  if (windows) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') console.error(error); }
    killTimer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') console.error(error); }
    }, 5000);
    killTimer.unref();
  }
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.on('error', error => { console.error('Could not start server:', error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  clearTimeout(killTimer);
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
});

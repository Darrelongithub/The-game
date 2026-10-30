// Start the real game server and the independent oracle locally, run the
// unmodified root smoke bots, then remove every synthetic log/oracle file.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'reveal-smoke-oracle-'));
const oracle = join(dir, 'oracle.json');
const env = { ...process.env, XAI_API_KEY: '', GEMINI_API_KEY: '', SMOKE_PRIVATE_DIR: dir, SMOKE_ORACLE: oracle };
if (env.SMOKE_FAST === '1') console.log('SMOKE_FAST: isolated fixture uses shortened live-moment timers; assertions are unchanged.');
const fixture = spawn(process.execPath, ['--import', 'tsx', join(root, 'scripts/smoke-oracle-server.mjs')], {
  cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
fixture.stderr.on('data', (chunk) => { output += chunk.toString(); });
try {
  const port = await new Promise((resolvePort, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Smoke fixture failed to start: ${output}`)), 15_000);
    fixture.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = output.match(/SMOKE_FIXTURE_PORT=(\d+)/);
      if (match) { clearTimeout(timeout); resolvePort(Number(match[1])); }
    });
    fixture.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Smoke fixture exited ${code}: ${output}`)); });
  });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const bot = spawn(npm, ['run', 'smoke'], { cwd: root, env: { ...env, SMOKE_URL: `http://127.0.0.1:${port}`, SMOKE_BOTS: '5', SMOKE_TIMEOUT_MS: '480000' }, stdio: 'inherit' });
  const [code] = await once(bot, 'exit');
  if (code !== 0) process.exitCode = typeof code === 'number' ? code : 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  fixture.kill('SIGTERM');
  if (fixture.exitCode === null && fixture.signalCode === null) await once(fixture, 'exit').catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

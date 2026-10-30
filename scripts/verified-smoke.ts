/** Local-only integration harness: runs the unchanged production services with
 * independent server-side disk/Socket.IO/engine observations. No debug endpoint
 * or oracle is exposed by the hosted production server. */
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { createGameServer } from '../apps/server/src/server.ts';
import { createIntegratedServices } from '../apps/server/src/integrated-services.ts';
import { CallGuard, Provider } from '../packages/prompts/src/index.ts';
import type { LogRecord, Results, SecretDeckView } from '../packages/shared/src/contracts.ts';

const directory = mkdtempSync(join(tmpdir(), 'reveal-verified-smoke-'));
const oraclePath = join(directory, 'oracle.json');
const persist: { roomCode: string; file: string; roundId: string; playerId: string; clientUuid: string }[] = [];
const weights = new Map<string, ReadonlyMap<string, number>>();
let current: { roomCode: string; roomId: string; players: string[]; decks: Record<string, SecretDeckView | null>; results: Results; file: string } | undefined;
const frames: { recipient: string; owner: string; deck: SecretDeckView }[] = [];
let injectedLeak = false;

function publish(): void {
  if (!current) return;
  const rows = readFileSync(current.file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as LogRecord);
  const submissions = persist.filter(p => p.roomCode === current!.roomCode).map(p => ({
    roundId: p.roundId, playerId: p.playerId, clientUuid: p.clientUuid,
    // The on-disk log intentionally does not store UUIDs. There can be at most
    // one accepted answer per player/round, so count independently on disk.
    count: rows.filter(row => row.roundId === p.roundId && row.playerId === p.playerId).length,
  }));
  const darePasses = rows.flatMap(row => row.value.kind === 'dare' && row.value.status === 'passed' && row.value.reason
    ? [{ playerId: row.playerId, reason: row.value.reason }] : []);
  const picker = current.players[0]!, target = current.players[1]!;
  const picks = rows.filter(row => row.playerId === picker && row.value.kind === 'pick');
  const same = picks.filter(row => row.value.kind === 'pick' && row.value.target === target);
  const negative = same.filter(row => row.coding === 'friction' || row.coding === 'rivalry');
  const victim = current.results.claims.find(claim => claim.type === 'toxic' && claim.subjects.includes(target));
  const oracle = {
    roomCode: current.roomCode, decks: current.decks, secretFrames: frames, submissions, darePasses,
    joker: { playerId: picker, target, pickRounds: picks.length, sameTargetPicks: same.length,
      negativeNominations: negative.length, nominationWeight: weights.get(current.roomId)?.get(picker) ?? null,
      victimToxicConfidence: victim?.confidence ?? null },
  };
  // Atomic replacement prevents the client from reading a partially written file.
  const tmp = `${oraclePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(oracle), { mode: 0o600 });
  renameSync(tmp, oraclePath);
}

const provider = new Provider({ env: {}, guard: new CallGuard() });
const services = createIntegratedServices(provider, (room, observed) => weights.set(room, new Map(observed)));
const server = createGameServer({
  dataDir: join(directory, 'data'), services, revealHoldMs: 10, interludeHoldMs: 10,
  audit: {
    persisted(roomCode, file, request) { persist.push({ roomCode, file, ...request }); },
    decks(roomCode, roomId, players, decks, results) {
      const item = persist.find(p => p.roomCode === roomCode);
      if (!item) throw new Error('No persisted records for test room');
      current = { roomCode, roomId, players: [...players], decks: Object.fromEntries(players.map(id => [id, decks.has(id) ? structuredClone(decks.get(id)!) : null])), results: structuredClone(results), file: item.file };
      publish();
    },
  },
});
// Socket.IO calls onAnyOutgoing for both direct emits and broadcasts, so an
// accidental broadcast is observed for *every* actual recipient, not merely
// the intended owner. Ambiguous/unrecognized decks fail closed in bots.ts.
server.io.on('connection', socket => {
  socket.onAnyOutgoing((event, ...args) => {
    if (event !== 'secrets' || !current) return;
    const deck = structuredClone(args[0]) as SecretDeckView;
    const owners = Object.entries(current.decks).filter(([, expected]) => expected !== null && isDeepStrictEqual(expected, deck)).map(([id]) => id);
    frames.push({ recipient: socket.data.playerId ?? 'unknown', owner: owners.length === 1 ? owners[0]! : 'unknown', deck });
    publish();
    // Test the oracle itself by deliberately leaking one deck in this isolated
    // harness. This branch cannot be enabled in the production entry point.
    if (process.env.SMOKE_INJECT_LEAK === '1' && !injectedLeak) {
      injectedLeak = true;
      const roomCode = current.roomCode;
      queueMicrotask(() => server.io.to(roomCode).emit('secrets', deck));
    }
  });
});

async function main(): Promise<void> {
try {
  const port = await server.listen(0, '127.0.0.1', false);
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/bots.ts'], {
    cwd: process.cwd(), stdio: 'inherit', env: { ...process.env, XAI_API_KEY: '', GEMINI_API_KEY: '', SMOKE_URL: `http://127.0.0.1:${port}`, SMOKE_ORACLE: oraclePath, SMOKE_TIMEOUT_MS: '120000' },
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (value, signal) => resolve(value ?? (signal ? 1 : 0)));
  });
  process.exitCode = code;
} finally {
  await server.close();
  rmSync(directory, { recursive: true, force: true });
}
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

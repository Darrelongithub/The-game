// TEST ONLY: independent, local-only oracle for scripts/bots.ts. No endpoint
// exposes this data; the orchestrator creates a private temporary directory and
// removes it afterward. Never use this harness with real players or keys.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGameServer } from '../apps/server/src/server.ts';
import { integratedServices } from '../apps/server/src/integratedServices.ts';
import { jokerNominationWeights } from '../packages/engine/src/index.ts';

const dir = process.env.SMOKE_PRIVATE_DIR;
if (!dir || !process.env.SMOKE_ORACLE || !process.env.SMOKE_ORACLE.startsWith(`${dir}/`)) {
  throw new Error('A private, temporary smoke directory and oracle path are required.');
}
delete process.env.XAI_API_KEY;
delete process.env.GEMINI_API_KEY;
const actualScoring = new Map();
const frames = new Map();
const services = {
  ...integratedServices,
  computeResults(signals, log, meta, provider) {
    const result = integratedServices.computeResults(signals, log, meta, provider);
    actualScoring.set(meta.roomId, {
      // This is the same pure helper used by computeResults, on the exact
      // scoring input, not a guess reconstructed from client messages.
      weights: jokerNominationWeights(log, meta.players.map((p) => p.id)),
      result,
    });
    return result;
  },
};
const server = createGameServer({ dataDir: join(dir, 'data'), services, revealHoldMs: 100, interludeHoldMs: 100 });
const roomFor = (socket) => server.rooms.rooms.get(socket.data.roomCode);

function update(room) {
  const scoring = actualScoring.get(room.id);
  if (!scoring || room.stage !== 'finale') return;
  const contents = readFileSync(room.file, 'utf8').trim();
  const records = contents ? contents.split('\n').map((line) => JSON.parse(line)) : [];
  const [joker, victim] = room.players;
  const picks = records.filter((r) => r.playerId === joker.id && r.value.kind === 'pick');
  const same = picks.filter((r) => r.value.target === victim.id);
  const submissions = [...room.seen].map(([key, entry]) => {
    const [playerId, clientUuid] = key.split('\u0000');
    return { roundId: entry.roundId, playerId, clientUuid,
      count: records.filter((r) => r.roundId === entry.roundId && r.playerId === playerId).length };
  });
  const toxic = scoring.result.claims.find((claim) => claim.type === 'toxic' && claim.subjects.includes(victim.id));
  const oracle = {
    roomCode: room.code,
    decks: Object.fromEntries(room.players.map((p) => [p.id, room.decks.get(p.id) ?? null])),
    submissions,
    secretFrames: frames.get(room.code) ?? [],
    darePasses: records.filter((r) => r.value.kind === 'dare' && r.value.status === 'passed')
      .map((r) => ({ playerId: r.playerId, reason: r.value.reason })),
    joker: {
      playerId: joker.id, target: victim.id, pickRounds: picks.length, sameTargetPicks: same.length,
      nominationWeight: scoring.weights.get(joker.id),
      negativeNominations: same.filter((r) => r.coding === 'friction' || r.coding === 'rivalry').length,
      victimToxicConfidence: toxic?.confidence ?? null,
    },
  };
  const temp = `${process.env.SMOKE_ORACLE}.tmp`;
  writeFileSync(temp, JSON.stringify(oracle), { mode: 0o600 });
  renameSync(temp, process.env.SMOKE_ORACLE);
}

// onAnyOutgoing runs per recipient for both direct Socket#emit and broadcasts
// with the in-memory Socket.IO adapter. Identify the actual owner from the
// server's deck object, independently of what any client claims it received.
server.io.on('connection', (socket) => {
  socket.onAnyOutgoing((event, value) => {
    const room = roomFor(socket);
    if (!room || !['finale', 'secrets'].includes(event)) return;
    if (event === 'secrets') {
      const owner = [...room.decks].find(([, deck]) => deck === value)?.[0] ?? '';
      const list = frames.get(room.code) ?? [];
      list.push({ recipient: socket.data.playerId ?? '', owner, deck: structuredClone(value) });
      frames.set(room.code, list);
    }
    update(room);
  });
});
const port = await server.listen(0, '127.0.0.1', false);
console.log(`SMOKE_FIXTURE_PORT=${port}`);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await server.close();
  process.exit(0);
};
process.on('SIGINT', close);
process.on('SIGTERM', close);

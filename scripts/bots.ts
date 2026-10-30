/** External Socket.IO end-to-end test. See RUNBOOK.md for the independent oracle. */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { io, type Socket } from 'socket.io-client';
import { DECOYS, SPOTLIGHT_IDLE_LINE } from '../packages/prompts/src/bank/live/index.ts';
import {
  MAX_PLAYERS, MIN_PLAYERS, SECRET_DECK_MAX,
  type ClientToServerEvents, type ServerToClientEvents, type RoomView,
  type RoundView, type FinaleView, type SecretDeckView, type JoinReply,
  type ResponseValue, type SubmitRequest, type Phase,
} from '../packages/shared/src/contracts.ts';

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type Bot = {
  alias: string; socket: GameSocket; id: string; secret: string;
  state?: RoomView; finales: FinaleView[]; decks: SecretDeckView[];
  seenRounds: Set<string>; deleted: boolean;
};
type Oracle = {
  roomCode: string;
  decks: Record<string, SecretDeckView | null>;
  submissions: { roundId: string; playerId: string; clientUuid: string; count: number }[];
  secretFrames: { recipient: string; owner: string; deck: SecretDeckView }[];
  darePasses: { playerId: string; reason: string }[];
  joker: { playerId: string; target: string; pickRounds: number; sameTargetPicks: number; nominationWeight: number; negativeNominations: number; victimToxicConfidence: "low" | "med" | "high" | null };
};
const address = process.env.SMOKE_URL ?? 'http://localhost:3001';
const count = Number(process.env.SMOKE_BOTS ?? '5');
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? '480000');
const oraclePath = process.env.SMOKE_ORACLE;
const consent = { age: true, terms: true, revealOptIn: true };
const bots: Bot[] = [];
const phases = new Set<Phase>(['lobby']);
const pending = new Set<Promise<void>>();
const errors: string[] = [];
let code = '';
// ROUND 3 live moments: the night must actually run both kinds.
const liveKinds = new Set<string>();
// A cover is counted once per spotlight round: the server re-sends the round on
// every state change, and the same phone can legitimately see it twice.
const coverRounds = new Set<string>();
let reconnectStarted = false;
let reconnectDone = false;
let duplicate: { roundId: string; playerId: string; clientUuid: string } | undefined;
let passDone = false;
let speedDone = false;
let stopping = false;

function check(condition: unknown, message: string): asserts condition {
  assert.ok(condition, message);
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, message: string, ms = timeoutMs): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (errors.length) throw new Error(errors.join('\n'));
    if (Date.now() >= end) throw new Error(`Timed out: ${message}`);
    await sleep(50);
  }
}
function track(work: Promise<void>): void {
  pending.add(work);
  void work.catch(error => errors.push(error instanceof Error ? error.message : String(error)))
    .finally(() => pending.delete(work));
}
function newSocket(): GameSocket {
  return io(address, { autoConnect: false, reconnection: false, timeout: 10000 });
}
async function connect(socket: GameSocket): Promise<void> {
  const connected = new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  socket.connect();
  await connected;
}
function install(bot: Bot, socket: GameSocket): void {
  socket.on('state', state => { bot.state = state; phases.add(state.phase); });
  socket.on('round', round => {
    phases.add(round.phase);
    if (round.kind === 'spotlight' || round.kind === 'verdict') liveKinds.add(round.kind);
    // A spotlight cover screen is either the idle line or a decoy question —
    // never the question the rest of the room is answering.
    const cover = round.kind === 'spotlight' && (round.expectsAnswer === false || round.promptText === SPOTLIGHT_IDLE_LINE || DECOYS.some(decoy => decoy.text === round.promptText));
    if (cover) coverRounds.add(round.roundId);
    if (stopping || bot.seenRounds.has(round.roundId)) return;
    bot.seenRounds.add(round.roundId);
    track(answer(bot, round));
  });
  socket.on('finale', finale => { phases.add('finale'); bot.finales.push(finale); });
  socket.on('secrets', deck => { bot.decks.push(deck); });
  socket.on('deleted', () => { bot.deleted = true; });
  socket.on('error', error => { errors.push(`${bot.alias}: ${error.code}: ${error.message}`); });
}
async function create(bot: Bot): Promise<JoinReply & { code?: string }> {
  return await bot.socket.timeout(10000).emitWithAck('create', { alias: bot.alias, consent });
}
async function join(bot: Bot, resume: boolean): Promise<JoinReply> {
  return await bot.socket.timeout(10000).emitWithAck('join', {
    roomCode: code, alias: bot.alias, consent,
    ...(resume ? { resume: { playerId: bot.id, secret: bot.secret } } : {}),
  });
}
function acceptJoin(bot: Bot, reply: JoinReply): void {
  check(reply.ok && reply.you && reply.secret && reply.state, `join failed for ${bot.alias}: ${reply.error ?? 'incomplete reply'}`);
  bot.id = reply.you; bot.secret = reply.secret; bot.state = reply.state;
  phases.add(reply.state.phase);
}
async function reconnect(bot: Bot, expectedPhase?: Phase): Promise<void> {
  const oldId = bot.id;
  const seq = bot.state?.seq ?? 0;
  bot.socket.disconnect();
  const socket = newSocket();
  bot.socket = socket;
  install(bot, socket);
  await connect(socket);
  const reply = await join(bot, true);
  acceptJoin(bot, reply);
  check(bot.id === oldId, `${bot.alias}: resume changed player identity`);
  check(bot.state && bot.state.seq >= seq, `${bot.alias}: resume snapshot went backwards`);
  if (expectedPhase) check(bot.state.phase === expectedPhase, `${bot.alias}: resume snapshot has wrong phase`);
}
function valueFor(bot: Bot, round: RoundView): ResponseValue {
  const index = bots.indexOf(bot);
  const target = index === 0 ? bots[1] : bots[(index + 1) % bots.length];
  check(target && target.id !== bot.id, 'invalid bot target');
  switch (round.kind) {
    case 'pick': return { kind: 'pick', target: target.id };
    case 'text': case 'debrief': return { kind: 'text', text: 'We laughed and agreed to keep the group chat alive.' };
    case 'shout': return { kind: 'shout', word: 'chaos' };
    case 'rating': return { kind: 'rating', trait: 'loyalty', about: index % 2 ? target.id : 'self', value: 7 };
    case 'ios': return { kind: 'ios', about: target.id, value: 5 };
    case 'minigame': return { kind: 'minigame', score: 30 + index };
    case 'dare': case 'pair_dare': return { kind: 'dare', status: 'done' };
    // Live moments (ROUND 3): a spotlight caption is a short text, a verdict is
    // a normal pick — the server opens the pick window only after the debate.
    case 'spotlight': return { kind: 'text', text: `Caption from ${bot.alias}.` };
    case 'verdict': return { kind: 'pick', target: target.id };
  }
}
async function answer(bot: Bot, round: RoundView): Promise<void> {
  const opened = Date.now();
  if (round.youSubmitted || (round.onlyPlayers && !round.onlyPlayers.includes(bot.id))) return;
  const index = bots.indexOf(bot);
  // Force one real connection loss while a round is active, not just a retry of join.
  if (index === bots.length - 1 && !reconnectStarted) {
    reconnectStarted = true;
    await reconnect(bot);
    check(bot.state?.round?.roundId === round.roundId, 'active resume did not restore the round snapshot');
    reconnectDone = true;
  }
  // Bot 2 is deliberately fast; the host submits early enough to retry before
  // the others finish. Remaining players have staggered human-ish delays.
  await sleep(index === 2 ? 100 : index === 0 ? 250 : 900 + index * 150);
  if (stopping) return;
  // Verdict rounds are phones-down first: wait for the secret pick window.
  if (round.voteOpensAt && round.voteOpensAt > Date.now()) {
    await waitFor(() => Date.now() >= round.voteOpensAt!, 'verdict vote window', Math.max(timeoutMs, round.voteOpensAt - Date.now() + 10000));
    if (stopping) return;
  }
  if (index === 1 && round.kind === 'dare' && !passDone) {
    passDone = true;
    bot.socket.emit('dare_pass', { roundId: round.roundId, reason: 'My mother is watching.' });
    return;
  }
  if (index === 2 && Date.now() - opened < 1000) speedDone = true;
  const request: SubmitRequest = { roundId: round.roundId, clientUuid: randomUUID(), value: valueFor(bot, round) };
  const result = await bot.socket.timeout(10000).emitWithAck('submit', request);
  check(result.ok, `${bot.alias}: submit rejected: ${result.error ?? round.kind}`);
  if (index === 0 && !duplicate) {
    duplicate = { roundId: round.roundId, playerId: bot.id, clientUuid: request.clientUuid };
    const again = await bot.socket.timeout(10000).emitWithAck('submit', request);
    check(again.ok, `duplicate submit rejected: ${again.error ?? ''}`);
  }
}
async function verifyOracle(): Promise<void> {
  check(oraclePath, 'SMOKE_ORACLE is required: socket events cannot prove deck ownership or stored idempotence; see RUNBOOK.md');
  const oracle = JSON.parse(await readFile(oraclePath, 'utf8')) as Oracle;
  check(oracle.roomCode === code && oracle.decks && Array.isArray(oracle.submissions) && Array.isArray(oracle.secretFrames) && Array.isArray(oracle.darePasses) && oracle.joker, 'oracle is malformed or for a different room');
  check(duplicate, 'no duplicate submission was exercised');
  const matching = oracle.submissions.filter(row => row.roundId === duplicate!.roundId && row.playerId === duplicate!.playerId && row.clientUuid === duplicate!.clientUuid);
  check(matching.length === 1 && matching[0].count === 1, 'duplicate submit was not persisted exactly once');
  check(oracle.darePasses.some(pass => pass.playerId === bots[1].id && pass.reason === 'My mother is watching.'), 'dare pass reason was not stored verbatim');
  const joker = oracle.joker;
  check(joker.playerId === bots[0].id && joker.target === bots[1].id && joker.pickRounds > 0 && joker.sameTargetPicks === joker.pickRounds && joker.negativeNominations > 0 && joker.nominationWeight === 0.5 && (joker.victimToxicConfidence === null || joker.victimToxicConfidence === 'low' || joker.victimToxicConfidence === 'med'), 'joker guard did not protect the fixed-target victim');
  const publicFinale = JSON.stringify(bots[0].finales[0]);
  check(!publicFinale.includes('"cards"'), 'public finale contains a private deck');
  for (const deck of Object.values(oracle.decks)) if (deck) for (const card of deck.cards) {
    check(!publicFinale.includes(JSON.stringify(card)), 'public finale contains a private card');
  }
  for (const frame of oracle.secretFrames) check(frame.owner === frame.recipient, 'secret frame delivered to a non-owner');
  check(oracle.secretFrames.every(frame => bots.some(bot => bot.id === frame.recipient)), 'oracle has an unknown secret recipient');
  for (const bot of bots) {
    const frames = oracle.secretFrames.filter(frame => frame.recipient === bot.id);
    assert.deepStrictEqual(frames.map(frame => frame.deck), bot.decks, `${bot.alias}: secret emission trace differs from received frames`);
    check(Object.hasOwn(oracle.decks, bot.id), `oracle missing owner ${bot.id}`);
    const expected = oracle.decks[bot.id];
    if (expected === null) {
      check(bot.decks.length === 0, `${bot.alias} received an unowned secrets frame`);
    } else {
      check(expected && Array.isArray(expected.cards) && expected.cards.length > 0, `invalid expected deck for ${bot.alias}`);
      check(expected.cards.length <= SECRET_DECK_MAX, `${bot.alias}'s oracle deck exceeds limit`);
      check(bot.decks.length > 0, `${bot.alias} did not receive its secrets`);
      for (const deck of bot.decks) {
        check(Array.isArray(deck.cards) && deck.cards.length <= SECRET_DECK_MAX, `${bot.alias}: oversized or invalid deck`);
        assert.deepStrictEqual(deck, expected, `${bot.alias} received a deck not belonging to them`);
      }
    }
  }
}
async function main(): Promise<void> {
  check(Number.isInteger(count) && count >= MIN_PLAYERS && count <= MAX_PLAYERS, `SMOKE_BOTS must be ${MIN_PLAYERS}..${MAX_PLAYERS}`);
  check(Number.isFinite(timeoutMs) && timeoutMs > 0, 'invalid SMOKE_TIMEOUT_MS');
  // Establish all listeners before starting: frames can arrive before acks.
  for (let i = 0; i < count; i++) {
    const socket = newSocket();
    const bot: Bot = { alias: `Smoke ${i + 1}`, socket, id: '', secret: '', finales: [], decks: [], seenRounds: new Set(), deleted: false };
    bots.push(bot); install(bot, socket); await connect(socket);
    if (i === 0) {
      const reply = await create(bot);
      check(reply.code, `create failed: ${reply.error ?? 'missing code'}`);
      code = reply.code; acceptJoin(bot, reply);
    } else acceptJoin(bot, await join(bot, false));
  }
  console.log(`Smoke room ${code}: ${count} players at ${address}`);
  // Ensure the live scenario includes a negative nomination: bank ordering
  // alone does not guarantee a friction/rivalry pick on every night.
  bots[0].socket.emit('custom_prompts', { lines: ['spicy: Who here would argue with a rival?'] });
  bots[0].socket.emit('start');
  await waitFor(() => bots.every(bot => bot.finales.length > 0), 'finale on every socket');
  await waitFor(() => pending.size === 0, 'pending submissions', 15000);
  for (const phase of ['lobby', 'warmup', 'spicy', 'deep', 'dare', 'debrief', 'finale'] as const) {
    check(phases.has(phase), `phase not reached: ${phase}`);
  }
  check(liveKinds.has('spotlight'), 'no spotlight live moment was played');
  check(liveKinds.has('verdict'), 'no verdict live moment was played');
  check(coverRounds.size > 0, 'no spotlight subject ever received a cover screen');
  check(reconnectDone, 'active disconnect/rejoin was not exercised');
  check(passDone, 'dodger never passed a dare');
  check(speedDone, 'speed demon did not submit in under one second');
  check(duplicate, 'duplicate submit was not exercised');
  for (const bot of bots) for (const finale of bot.finales) assert.deepStrictEqual(finale, bots[0].finales[0], 'finale differs across sockets');
  // Select a real owner from the independent oracle, not from observed client
  // frames: an accidental leak must not make a non-owner look like an owner.
  await sleep(1500);
  check(oraclePath, 'SMOKE_ORACLE is required: see RUNBOOK.md');
  const resumeOracle = JSON.parse(await readFile(oraclePath, 'utf8')) as Oracle;
  check(resumeOracle.roomCode === code && resumeOracle.decks, 'resume oracle is malformed or for a different room');
  const resuming = bots.find(bot => resumeOracle.decks[bot.id] != null) ?? bots[bots.length - 1];
  const expectedDeck = resumeOracle.decks[resuming.id];
  const before = resuming.decks.length;
  await reconnect(resuming, 'finale');
  if (expectedDeck) await waitFor(() => resuming.decks.length > before, 'post-finale secrets redelivery', 10000);
  else await sleep(1500);
  for (const finale of resuming.finales) assert.deepStrictEqual(finale, bots[0].finales[0], 'finale changed on resume');
  await verifyOracle();
  bots[bots.length - 1].socket.emit('delete_room');
  await waitFor(() => bots.every(bot => bot.deleted), 'deleted on every socket', 10000);
  const probe = newSocket();
  try {
    await connect(probe);
    const afterDelete = await probe.timeout(10000).emitWithAck('join', {
      roomCode: code, alias: bots[0].alias, consent,
      resume: { playerId: bots[0].id, secret: bots[0].secret },
    });
    check(!afterDelete.ok, 'deleted room accepted a resumed player');
  } finally { probe.disconnect(); }
  stopping = true;
  console.log(`PASS: phases, finale equality, secret ownership and deck limits, duplicate persistence, active and finale resume, dare pass, deletion`);
  console.log(`PASS (ROUND 3): live moments played — spotlight + verdict; ${coverRounds.size} cover screen(s) seen on subject phones`);
}
main().catch(async error => {
  console.error(`SMOKE FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
  // Do not leave a test room or its sensitive logs behind after failure.
  const connected = bots.find(bot => bot.socket.connected);
  if (code && connected && !connected.deleted) {
    connected.socket.emit('delete_room');
    await sleep(300);
  }
}).finally(() => {
  stopping = true;
  for (const bot of bots) bot.socket.disconnect();
});

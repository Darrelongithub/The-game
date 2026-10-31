/**
 * R27 — reproducible spark-incidence measurement.
 *
 * Two cohorts are measured with the SAME production engine and the SAME
 * denominators before/after the confidence gate:
 *
 *  1. `fixtures`: seeded engine bot rooms (uniform-random noise + a scripted
 *     mutual room). This cohort is byte-reproducible and is the primary
 *     before/after comparison.
 *  2. `live`: real Socket.IO bots against the production server with keys
 *     disabled. Bot answers are seeded; the server still chooses its own room
 *     id/live seeds, so this cohort is an observational cross-check.
 *
 * Denominators:
 *  - per-round = spark secret cards / completed rounds (a spark is announced
 *    once per holder at the finale, so this is announcements per round).
 *  - per-night = nights with >=1 spark secret card / nights.
 * Spark claims are reported separately from announced cards.
 *
 * Run: npm run measure:sparks
 * Env: SPARK_NOISE_NIGHTS (default 200 fixture nights),
 *      SPARK_LIVE_NOISE_NIGHTS (default 30 live nights),
 *      SPARK_MUTUAL_NIGHTS (default 10), SPARK_LIVE=0 to skip live bots.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { createGameServer } from '../apps/server/src/server.ts';
import { createProductionServices } from '../apps/server/src/integratedServices.ts';
import { buildNightDigest, buildSecrets, computeResults, computeSignals } from '../packages/engine/src/index.ts';
import { mulberry32 } from '../packages/engine/src/rng.ts';
import { RANDOM_META, goldenLog1, meta5, randomLog } from '../packages/engine/test/fixtures.ts';
import type {
  ClientToServerEvents, JoinReply, LogRecord, ResponseValue, Results,
  RoundView, SecretDeckView, ServerToClientEvents,
} from '../packages/shared/src/contracts.ts';

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type Policy = 'noise' | 'mutual';
interface NightCount {
  cohort: string; policy: Policy; seed: number; rounds: number;
  sparkClaims: number; sparkCards: number;
}
interface Summary {
  cohort: string; policy: Policy; nights: number; rounds: number;
  sparkClaims: number; sparkCards: number; sparkNights: number;
  claimsPerRound: number; cardsPerRound: number; nightsWithSparkRate: number;
}
const consent = { age: true, terms: true, revealOptIn: true };
const profile = { age: 28, relationship: 'single' as const, partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: 'vibes' as const };
const noiseNights = Number(process.env.SPARK_NOISE_NIGHTS ?? '200');
const liveNoiseNights = Number(process.env.SPARK_LIVE_NOISE_NIGHTS ?? '30');
const mutualNights = Number(process.env.SPARK_MUTUAL_NIGHTS ?? '10');
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const rate = (n: number, d: number): number => d === 0 ? 0 : n / d;

function summarize(cohort: string, policy: Policy, rows: NightCount[]): Summary {
  const rounds = rows.reduce((n, r) => n + r.rounds, 0);
  const sparkClaims = rows.reduce((n, r) => n + r.sparkClaims, 0);
  const sparkCards = rows.reduce((n, r) => n + r.sparkCards, 0);
  const sparkNights = rows.filter((r) => r.sparkCards > 0).length;
  return {
    cohort, policy, nights: rows.length, rounds, sparkClaims, sparkCards, sparkNights,
    claimsPerRound: rate(sparkClaims, rounds), cardsPerRound: rate(sparkCards, rounds),
    nightsWithSparkRate: rate(sparkNights, rows.length),
  };
}
function print(summary: Summary): void {
  console.log(`SPARK_INCIDENCE ${JSON.stringify(summary)}`);
}
function countResults(results: Results, decks: ReadonlyMap<string, SecretDeckView>, rounds: number): { sparkClaims: number; sparkCards: number; rounds: number } {
  return {
    rounds,
    sparkClaims: results.claims.filter((c) => c.type === 'spark').length,
    sparkCards: [...decks.values()].flatMap((d) => d.cards).filter((c) => c.kind === 'spark').length,
  };
}

function fixtureCohort(): void {
  const noise: NightCount[] = [];
  for (let seed = 0; seed < noiseNights; seed++) {
    const log = randomLog(seed);
    const signals = computeSignals(log, RANDOM_META);
    const results = computeResults(signals, log, RANDOM_META);
    const decks = buildSecrets(results, buildNightDigest(log, RANDOM_META), RANDOM_META);
    const rounds = new Set(log.map((r) => r.roundId)).size;
    const counted = countResults(results, new Map([...decks].map(([id, cards]) => [id, { cards }])), rounds);
    noise.push({ cohort: 'fixtures', policy: 'noise', seed, ...counted });
  }
  const mutual: NightCount[] = [];
  for (let seed = 0; seed < mutualNights; seed++) {
    const log = goldenLog1();
    const meta = meta5(`room-mutual-${seed}`);
    const signals = computeSignals(log, meta);
    const results = computeResults(signals, log, meta);
    const decks = buildSecrets(results, buildNightDigest(log, meta), meta);
    const rounds = new Set(log.map((r) => r.roundId)).size;
    const counted = countResults(results, new Map([...decks].map(([id, cards]) => [id, { cards }])), rounds);
    mutual.push({ cohort: 'fixtures', policy: 'mutual', seed, ...counted });
  }
  print(summarize('fixtures', 'noise', noise));
  print(summarize('fixtures', 'mutual', mutual));
}

async function liveCohort(): Promise<void> {
  delete process.env.XAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const directory = mkdtempSync(join(tmpdir(), 'reveal-spark-incidence-'));
  let file = '';
  const state: { observed?: { results: Results; decks: ReadonlyMap<string, SecretDeckView> } } = {};
  const server = createGameServer({
    dataDir: join(directory, 'data'),
    services: createProductionServices(),
    roundTimers: { spotlight: 100, verdict: 200, pick: 200, text: 200, shout: 200, rating: 200, ios: 200, minigame: 200, dare: 200, pair_dare: 200, debrief: 200, confess: 200 },
    verdictDiscussMs: 0, graceMs: 10, revealHoldMs: 1, interludeHoldMs: 1, readyGraceMs: 1,
    audit: {
      persisted(_roomCode, path) { file = path; },
      decks(_roomCode, _roomId, _players, decks, results) { state.observed = { results, decks }; },
    },
  });
  const port = await server.listen(0, '127.0.0.1', false);
  const base = `http://127.0.0.1:${port}`;

  async function runNight(seed: number, policy: Policy): Promise<NightCount> {
    state.observed = undefined;
    file = '';
    const rng = mulberry32(seed);
    const sockets: GameSocket[] = [];
    const ids: string[] = [];
    const seen: Set<string>[] = [];
    const errors: string[] = [];
    let code = '';
    let finale = false;
    try {
      for (let i = 0; i < 5; i++) {
        const socket = io(base, { autoConnect: false, reconnection: false, forceNew: true });
        sockets.push(socket);
        seen.push(new Set());
        socket.on('error', (error) => errors.push(`${error.code}: ${error.message}`));
        socket.on('state', (state) => { if (state.ready) socket.emit('ready'); });
        socket.on('finale', () => { finale = true; });
        socket.on('round', (round: RoundView) => {
          if (finale || round.youSubmitted || round.expectsAnswer === false || seen[i]!.has(round.roundId)) return;
          if (round.onlyPlayers && !round.onlyPlayers.includes(ids[i]!)) return;
          seen[i]!.add(round.roundId);
          const others = ids.filter((id) => id !== ids[i]);
          const mutualPair = policy === 'mutual' && (i === 0 || i === 1);
          const partner = ids[i === 0 ? 1 : 0]!;
          // The mutual room keeps three independent supports: it agrees on
          // third targets outside the couple rounds, picks each other on
          // couple-coded/spicy/verdict rounds, and names each other in confess
          // rounds. Assigned IOS/rating subjects still get close answers when
          // the server happens to aim them at the partner.
          const pickTarget = mutualPair
            ? ((round.phase === 'spicy' || round.kind === 'verdict') ? partner : ids[2]!)
            : others[Math.floor(rng() * others.length)]!;
          const close = mutualPair && ((i === 0 && round.about === ids[1]) || (i === 1 && round.about === ids[0]));
          let value: ResponseValue;
          switch (round.kind) {
            case 'pick': case 'verdict': value = { kind: 'pick', target: pickTarget }; break;
            case 'rating': value = { kind: 'rating', trait: round.trait!, about: round.about!, value: close ? 9 : 1 + Math.floor(rng() * 10) }; break;
            case 'ios': value = { kind: 'ios', about: round.about!, value: close ? 7 : 1 + Math.floor(rng() * 7) }; break;
            case 'shout': value = { kind: 'shout', word: ['chaos', 'vibes', 'legend'][Math.floor(rng() * 3)]! }; break;
            case 'minigame': value = { kind: 'minigame', score: 10 + Math.floor(rng() * 51) }; break;
            case 'dare': case 'pair_dare': value = { kind: 'dare', status: 'done' }; break;
            case 'confess': value = { kind: 'confess', yes: mutualPair ? true : rng() < 0.5, ...(mutualPair ? { target: partner } : {}) }; break;
            default: value = { kind: 'text', text: mutualPair ? 'we talked about Nairobi and laughed together' : 'the group chat keeps surprising us tonight' };
          }
          const send = (): void => {
            socket.emit('submit', { roundId: round.roundId, clientUuid: `spark-${seed}-${i}-${round.roundId}`, value }, (reply: { ok: boolean; error?: string }) => {
              if (!reply.ok) errors.push(reply.error ?? 'submit failed');
            });
          };
          if (round.kind === 'verdict' && round.voteOpensAt && round.voteOpensAt > Date.now()) setTimeout(send, Math.max(0, round.voteOpensAt - Date.now()) + 5);
          else send();
        });
        await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('connect_error', reject); socket.connect(); });
        const reply = await new Promise<JoinReply & { code?: string }>((resolve) => i === 0
          ? socket.emit('create', { alias: `P${i}`, consent, profile }, resolve)
          : socket.emit('join', { roomCode: code, alias: `P${i}`, consent, profile }, resolve));
        if (!reply.ok || !reply.you) throw new Error(reply.error ?? 'join failed');
        ids.push(reply.you);
        if (i === 0) code = reply.code!;
      }
      sockets[0]!.emit('start');
      const end = Date.now() + 30_000;
      while (!state.observed && Date.now() < end) await sleep(20);
      const observed = state.observed as { results: Results; decks: ReadonlyMap<string, SecretDeckView> } | undefined;
      if (!observed) throw new Error(`no finale: ${errors.join('; ')}`);
      if (errors.length) throw new Error(errors.join('; '));
      const log = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as LogRecord);
      const rounds = new Set(log.map((r) => r.roundId)).size;
      return { cohort: 'live', policy, seed, ...countResults(observed.results, observed.decks, rounds) };
    } finally {
      for (const socket of sockets) socket.disconnect();
    }
  }

  try {
    const noise: NightCount[] = [];
    for (let seed = 0; seed < liveNoiseNights; seed++) noise.push(await runNight(seed, 'noise'));
    const mutual: NightCount[] = [];
    for (let seed = 0; seed < mutualNights; seed++) mutual.push(await runNight(seed, 'mutual'));
    print(summarize('live', 'noise', noise));
    print(summarize('live', 'mutual', mutual));
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  fixtureCohort();
  if (process.env.SPARK_LIVE !== '0') await liveCohort();
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

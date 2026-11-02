import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { createGameServer } from '../apps/server/src/server.ts';
import { buildNightDigest, computeResults, computeSignals } from '../packages/engine/src/index.ts';
import type { Results, LogRecord, RoomView, RoundView } from '../packages/shared/src/contracts.ts';
async function main() {

  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  const consent = { age: true, terms: true, revealOptIn: true };
  const profile = { age: 28, relationship: 'single' as const, partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: 'vibes' as const };
  let results: Results | undefined;
  const server = createGameServer({
    dataDir: dir, graceMs: 40, revealHoldMs: 25, interludeHoldMs: 20, botDelayMs: [5, 15], readyGraceMs: 200,
    roundTimers: { pick: 400, text: 400, shout: 400, rating: 400, ios: 400, minigame: 400, dare: 400, pair_dare: 400, debrief: 400, spotlight: 500, verdict: 700 },
    verdictDiscussMs: 50,
    audit: { persisted() {}, decks(_c, _id, _p, _decks, r) { results = r; } },
  });
  const port = await server.listen(0, '127.0.0.1', false);
  const base = `http://127.0.0.1:${port}`;
  const clients: Socket[] = [];
  const roundsSeen: any[] = [];
  const errorsSeen: any[] = [];
  const readySeen: RoomView[] = [];
  async function connect(): Promise<Socket> {
    const c: Socket = io(base, { forceNew: true, transports: ['websocket'], reconnection: false });
    clients.push(c);
    await new Promise<void>(r => c.on('connect', () => r()));
    c.on('error', (e: any) => errorsSeen.push(e));
    c.on('state', (v: any) => { if (v.ready) { readySeen.push(v); c.emit('ready'); } });
    return c;
  }
  const ack = (c: Socket, ev: string, p: any) => new Promise<any>(r => c.emit(ev, p, r));
  const host = await connect();
  const made = await ack(host, 'create', { alias: 'Ada', consent, profile });
  const code = made.code;
  const others = [await connect(), await connect(), await connect()];
  const names = ['Ben', 'Cleo', 'Dara'];
  for (let i = 0; i < others.length; i++) await ack(others[i], 'join', { roomCode: code, alias: names[i], consent, profile });
  const seats = [made.you, ...(await Promise.all([])), ];
  const me = [host, ...others];
  const stateRef: { v?: RoomView } = {};
  host.on('state', (v: any) => { stateRef.v = v; });
  const ids = () => (stateRef.v?.players ?? []).map(p => p.id);
  host.on('round', (r: RoundView) => roundsSeen.push(r));

  host.emit('start');
  // answer all rounds
  let selfReject: any;
  const answer = async (r: RoundView, self: string) => {
    if (r.youSubmitted) return;
    if (r.expectsAnswer === false) return;
    if (r.kind === 'spotlight') return void await ack(host, 'submit', { roundId: r.roundId, clientUuid: 'u' + r.roundId + self, value: { kind: 'text', text: 'caption for the room' } });
    if (r.kind === 'text' || r.kind === 'debrief') return void await ack(host, 'submit', { roundId: r.roundId, clientUuid: 'u' + r.roundId + self, value: { kind: 'text', text: 'a longer answer about the night and everyone here' } });
    if (r.kind === 'pick' || r.kind === 'verdict') {
      const t = ids().find(i => i !== self);
      return void await ack(host, 'submit', { roundId: r.roundId, clientUuid: 'u' + r.roundId + self, value: { kind: 'pick', target: t } });
    }
    if (r.kind === 'shout') return void await ack(host, 'submit', { roundId: r.roundId, clientUuid: 'u' + r.roundId + self, value: { kind: 'shout', word: 'chaos' } });
    if (r.kind === 'minigame') return void await ack(host, 'submit', { roundId: r.roundId, clientUuid: 'u' + r.roundId + self, value: { kind: 'minigame', score: 50 } });
    if (r.kind === 'rating') {
      // probe: try about self first (what the bank/hint suggests)
      if (!selfReject) selfReject = await ack(host, 'submit', { roundId: r.roundId, clientUuid: 'self-' + r.roundId, value: { kind: 'rating', trait: r.trait!, about: 'self', value: 7 } });
      return void await ack(host, 'submit', { roundId: r.roundId, clientUuid: 'u' + r.roundId + self, value: { kind: 'rating', trait: r.trait!, about: r.about as any, value: 7 } });
    }
    if (r.kind === 'ios') return void await ack(host, 'submit', { roundId: r.roundId, clientUuid: 'u' + r.roundId + self, value: { kind: 'ios', about: r.about as any, value: 5 } });
    if (r.kind === 'dare' || r.kind === 'pair_dare') return void await ack(host, 'submit', { roundId: r.roundId, clientUuid: 'u' + r.roundId + self, value: { kind: 'dare', status: 'done' } });
  };
  for (let tick = 0; tick < 400; tick++) {
    await new Promise(r => setTimeout(r, 50));
    const st = stateRef.v;
    if (!st) continue;
    if (st.round && st.round.onlyPlayers && !st.round.onlyPlayers.includes(made.you)) continue;
    if (st.round) await answer(st.round, made.you);
    if (st.phase === 'finale') break;
  }
  await new Promise(r => setTimeout(r, 300));
  const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  const log: LogRecord[] = files.flatMap(f => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)));
  console.log('rounds seen', roundsSeen.length, 'errors', JSON.stringify(errorsSeen));
  console.log('SELF RATING RESULT', JSON.stringify(selfReject));
  console.log('RATING ROUNDS', JSON.stringify(roundsSeen.filter(r => r.kind === 'rating').map(r => ({ text: r.promptText, about: r.about, trait: r.trait })), null, 1));
  console.log('IOS ROUNDS', JSON.stringify(roundsSeen.filter(r => r.kind === 'ios').map(r => ({ text: r.promptText, about: r.about })), null, 1));
  console.log('round kinds', roundsSeen.map(r => r.kind).join(','));
  const aboutSelf = log.filter(l => l.value.kind === 'rating' && (l.value as any).about === 'self');
  console.log('log records', log.length, 'rating about self', aboutSelf.length);
  console.log('rating traits produced', JSON.stringify(log.filter(l => l.value.kind === 'rating').map(l => (l.value as any).trait)));
  const meta = { roomId: (log[0] as any)?.roomId ?? 'x', players: (stateRef.v?.players ?? []).map((p, i) => ({ id: p.id, alias: `Player ${i+1}` })), revealOptIn: ids(), profiles: undefined };
  const signals = computeSignals(log, meta as any);
  const res = computeResults(signals, log, meta as any);
  const digest = buildNightDigest(log, meta as any);
  console.log('claim types', JSON.stringify(res.claims.map(c => c.type)));
  console.log('selfVsRoom', JSON.stringify(digest.selfVsRoom));
  console.log('componentsUsed union', JSON.stringify([...new Set(signals.flatMap(s => s.componentsUsed))]));
  console.log('finale?', stateRef.v?.phase);
  for (const c of clients) c.disconnect();
  await server.close();
  rmSync(dir, { recursive: true, force: true });

}
void main();

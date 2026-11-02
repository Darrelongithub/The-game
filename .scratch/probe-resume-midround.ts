// STALL probe: a phone drops mid-round and comes back (nobody may refresh, but
// the browser tab CAN lose the socket). Does the returning seat get the live
// round back and can it still answer before the round closes?
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { createGameServer } from '../apps/server/src/server.ts';
import type { RoomView, RoundView } from '../packages/shared/src/contracts.ts';

const consent = { age: true, terms: true, revealOptIn: true };
const profile = { age: 28, relationship: 'single' as const, partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: 'vibes' as const };

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'probe-resume-'));
  const server = createGameServer({ dataDir: dir, graceMs: 80, revealHoldMs: 30, interludeHoldMs: 20, botDelayMs: [5, 15], readyGraceMs: 250,
    roundTimers: { pick: 3000, text: 3000, shout: 3000, rating: 3000, ios: 3000, minigame: 3000, dare: 3000, pair_dare: 3000, debrief: 3000, spotlight: 3000, verdict: 3000 }, verdictDiscussMs: 40 });
  const port = await server.listen(0, '127.0.0.1', false);
  const base = `http://127.0.0.1:${port}`;
  const sockets: Socket[] = [];
  const connect = async (): Promise<Socket> => {
    const c: Socket = io(base, { forceNew: true, transports: ['websocket'], reconnection: false });
    sockets.push(c);
    await new Promise<void>((r) => c.on('connect', () => r()));
    return c;
  };
  const ack = (c: Socket, ev: string, p: any) => new Promise<any>((r) => c.emit(ev, p, r));
  const host = await connect();
  const made = await ack(host, 'create', { alias: 'Ada', consent, profile });
  const code = made.code as string;
  const ids = [made.you];
  const seats: Socket[] = [host];
  const secrets = [made.secret];
  for (const n of ['Ben', 'Cleo', 'Dara']) {
    const c = await connect();
    const res = await ack(c, 'join', { roomCode: code, alias: n, consent, profile });
    ids.push(res.you); seats.push(c); secrets.push(res.secret);
  }
  const log: any = { resumedRound: null as RoundView | null, resumeState: null as RoomView | null, submit: null, rejects: [] as any[], roundOrder: [] as string[] };
  seats.forEach((s, i) => {
    const me = ids[i]!;
    s.on('state', (v: RoomView) => { if (v.ready && !v.ready.includes(me)) void ack(s, 'ready', {}); });
    s.on('round', (r: RoundView) => {
      log.roundOrder.push(`${me}:${r.kind}`);
      // Only the host answers; the rest stay silent so the round window stays open.
      if (me !== ids[0] || r.expectsAnswer === false || (r.onlyPlayers && !r.onlyPlayers.includes(me))) return;
      if (r.kind === 'spotlight') return;
      void (async () => {
        const value: any = r.kind === 'pick' || r.kind === 'verdict' ? { kind: 'pick', target: ids.find((x) => x !== me) }
          : r.kind === 'shout' ? { kind: 'shout', word: 'chaos' }
          : r.kind === 'rating' ? { kind: 'rating', trait: r.trait, about: r.about, value: 5 }
          : r.kind === 'ios' ? { kind: 'ios', about: r.about, value: 3 }
          : r.kind === 'minigame' ? { kind: 'minigame', score: 30 }
          : { kind: 'text', text: 'host answer for the room' };
        const res = await ack(s, 'submit', { roundId: r.roundId, clientUuid: `h-${r.roundId}`, value });
        if (!res.ok && r.kind !== 'verdict') log.rejects.push(res);
      })();
    });
  });

  host.emit('start');
  // Wait for the first round, then kill Ben's socket mid-round.
  let firstRound: RoundView | undefined;
  await new Promise<void>((resolve) => { seats[1]!.once('round', (r: RoundView) => { firstRound = r; resolve(); }); });
  const droppedAt = firstRound!.roundId;
  seats[1]!.disconnect();
  await new Promise((r) => setTimeout(r, 150));
  const back = await connect();
  back.once('round', (r: RoundView) => { log.resumedRound = r; });
  back.on('state', (v: RoomView) => { log.resumeState = v; });
  const resumed = await ack(back, 'join', { roomCode: code, alias: 'Ben', consent, profile, resume: { playerId: ids[1]!, secret: secrets[1] } });
  await new Promise((r) => setTimeout(r, 200));
  const captured = log.resumedRound as RoundView | null;
  log.submit = captured
    ? await ack(back, 'submit', { roundId: captured.roundId, clientUuid: `back-${captured.roundId}`, value: captured.kind === 'pick' || captured.kind === 'verdict' ? { kind: 'pick', target: ids[0] } : captured.kind === 'text' || captured.kind === 'spotlight' ? { kind: 'text', text: 'back online' } : captured.kind === 'shout' ? { kind: 'shout', word: 'back' } : { kind: 'minigame', score: 11 } })
    : 'no-round-after-resume';
  const { readdirSync, readFileSync } = await import('node:fs');
  const recs = readdirSync(dir).filter(f=>f.endsWith('.jsonl')).flatMap(f=>readFileSync(join(dir,f),'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)));
  const round1 = recs.filter((r:any)=>r.roundId===droppedAt);
  console.log(JSON.stringify({ round1Records: round1.map((r:any)=>({playerId:r.playerId, at:r.at, uuid:r.clientUuid ?? null, value:r.value})) }, null, 2));
  console.log(JSON.stringify({
    droppedInRound: droppedAt,
    resumeOk: resumed.ok,
    resumeError: resumed.ok ? undefined : resumed.error,
    gotRoundOnResume: log.resumedRound ? { roundId: log.resumedRound.roundId, kind: log.resumedRound.kind, youSubmitted: log.resumedRound.youSubmitted, submitted: (log.resumedRound as any).submitted, iAm: ids[1] } : null,
    sameRound: captured?.roundId === droppedAt,
    answeredBeforeDrop: captured ? captured.youSubmitted : null,
    stateStage: log.resumeState?.stage,
    submitAfterResume: log.submit,
    rejects: log.rejects,
  }, null, 2));
  process.exit(0);
}
void main();

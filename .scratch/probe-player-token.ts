// Two questions about the pseudonym round-trip, each answered by a real night
// (4 phones, no API keys — the offline finale is what a host without keys sees):
//
//   A) LIE (fixed in ea70c81): does a guest whose gamertag looks like a token
//      ("Player 3") re-name a *different* guest in public copy?
//   B) RULING R1 (still open): does a guest's own sentence "Player 2 …" come
//      back out naming a real guest?
//
// Every case is a full game; only the first dare/performer passes with a reason,
// so the finale always has a DODGE REPORT slide carrying that verbatim sentence.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { createGameServer } from '../apps/server/src/server.ts';
import type { RoundView } from '../packages/shared/src/contracts.ts';

const consent = { age: true, terms: true, revealOptIn: true };
const profile = { age: 28, relationship: 'single' as const, partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: 'vibes' as const };

async function night(names: [string, string, string], reason: string) {
  const dir = mkdtempSync(join(tmpdir(), 'probe-token-'));
  const server = createGameServer({
    dataDir: dir, graceMs: 40, revealHoldMs: 20, interludeHoldMs: 15, botDelayMs: [5, 10], readyGraceMs: 200,
    roundTimers: { pick: 300, text: 300, shout: 300, rating: 300, ios: 300, minigame: 300, dare: 600, pair_dare: 600, debrief: 300, spotlight: 400, verdict: 600 },
    verdictDiscussMs: 40,
  });
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
  const seats = [host];
  for (const n of names) {
    const c = await connect();
    const res = await ack(c, 'join', { roomCode: code, alias: n, consent, profile });
    ids.push(res.you); seats.push(c);
  }
  let finaleJson: any;
  let passAccepted = false;
  let submittedDare = false;
  seats.forEach((s, i) => {
    const me = ids[i]!;
    s.on('state', (v: any) => { if (v.ready && !v.ready.includes(me)) void ack(s, 'ready', {}); });
    s.on('round', (r: RoundView) => { void (async () => {
      if (r.expectsAnswer === false || (r.onlyPlayers && !r.onlyPlayers.includes(me))) return;
      const b = { roundId: r.roundId, clientUuid: `x-${r.roundId}-${me}` };
      if (r.kind === 'dare' || r.kind === 'pair_dare') {
        if (submittedDare) return;
        submittedDare = true;
        const who = r.onlyPlayers ?? (r.performer ? [r.performer] : []);
        const idx = ids.findIndex((id) => who.includes(id));
        const res = await ack(seats[idx >= 0 ? idx : 1]!, 'submit', { ...b, value: { kind: 'dare', status: 'passed', reason } });
        passAccepted = res.ok;
        return;
      }
      const value: any = r.kind === 'pick' || r.kind === 'verdict' ? { kind: 'pick', target: ids.find((x) => x !== me) }
        : r.kind === 'shout' ? { kind: 'shout', word: 'chaos' }
        : r.kind === 'rating' ? { kind: 'rating', trait: r.trait, about: r.about, value: 6 }
        : r.kind === 'ios' ? { kind: 'ios', about: r.about, value: 4 }
        : r.kind === 'minigame' ? { kind: 'minigame', score: 40 }
        : { kind: 'text', text: 'just a normal answer' };
      await ack(s, 'submit', { ...b, value });
    })(); });
  });
  host.on('finale', (f: any) => { finaleJson = f; });
  host.emit('start');
  for (let i = 0; i < 900 && !finaleJson; i++) await new Promise((r) => setTimeout(r, 50));
  const slides = finaleJson?.slides ?? [];
  for (const c of sockets) c.disconnect();
  return { roster: ['Ada', ...names], reason, passAccepted,
    dodgeSlides: slides.filter((s: any) => s.flavor === 'dodge').map((s: any) => `${s.title} | ${s.body}`) };
}

async function main() {
  // A) gamertag "Player 3" at seat 4 + a real mention of Samantha at seat 3.
  const a = await night(['Ben', 'Samantha', 'Player 3'], 'Samantha should do this instead of me.');
  // B) no token-shaped alias; the guest simply TYPES the token.
  const b = await night(['Ben', 'Cleo', 'Dara'], 'Truth is, Player 2 should do this instead of me.');
  console.log(JSON.stringify({ caseA_tokenShapedAlias: a, caseB_typedToken: b }, null, 2));
  process.exit(0);
}
void main();

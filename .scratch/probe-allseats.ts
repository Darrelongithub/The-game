// Every seat answers every round. Reconcile each reveal's stated numbers with
// the log (LIE check) and confirm every round closes and every reveal lands
// (STALL check). Also keeps a display socket joined to prove the big screen
// gets every round.
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { createGameServer } from '../apps/server/src/server.ts';
import type { LogRecord, RoomView, RoundView } from '../packages/shared/src/contracts.ts';

const consent = { age: true, terms: true, revealOptIn: true };
const profile = { age: 28, relationship: 'single' as const, partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: 'vibes' as const };

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'probe-allseats-'));
  const server = createGameServer({
    dataDir: dir, graceMs: 60, revealHoldMs: 30, interludeHoldMs: 20, botDelayMs: [5, 15], readyGraceMs: 400,
    roundTimers: { pick: 500, text: 500, shout: 500, rating: 500, ios: 500, minigame: 500, dare: 500, pair_dare: 500, debrief: 500, spotlight: 600, verdict: 900 },
    verdictDiscussMs: 60,
  });
  const port = await server.listen(0, '127.0.0.1', false);
  const base = `http://127.0.0.1:${port}`;
  const sockets: Socket[] = [];
  const rounds: { round: RoundView; at: number }[] = [];
  const reveals: any[] = [];
  const rejects: { roundId: string; error: string }[] = [];
  const displayRounds: RoundView[] = [];
  const displayReveals: any[] = [];

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
  const ids: string[] = [made.you];
  const seats: Socket[] = [host];
  for (const name of ['Ben', 'Cleo', 'Dara']) {
    const c = await connect();
    const res = await ack(c, 'join', { roomCode: code, alias: name, consent, profile });
    if (!res.ok) throw new Error(`join ${name}: ${JSON.stringify(res)}`);
    ids.push(res.you); seats.push(c);
  }
  const display = await connect();
  const dj = await ack(display, 'display_join', { roomCode: code });
  if (!dj.ok) throw new Error(`display_join: ${JSON.stringify(dj)}`);
  display.on('round', (r: RoundView) => displayRounds.push(r));
  display.on('reveal', (r: any) => displayReveals.push(r));

  const stateRef: { v?: RoomView } = {};
  let finalSeen = false;
  for (let i = 0; i < seats.length; i++) {
    const me = ids[i]!;
    seats[i]!.on('state', (v: RoomView) => {
      stateRef.v = v;
      if (v.ready && !v.ready.includes(me)) void ack(seats[i]!, 'ready', {});
    });
    seats[i]!.on('round', (r: RoundView) => {
      rounds.push({ round: r, at: Date.now() });
      // Answer immediately (except while a verdict vote window is shut).
      void (async () => {
        if (r.expectsAnswer === false) return;
        if (r.onlyPlayers && !r.onlyPlayers.includes(me)) return;
        if (r.youSubmitted) return;
        if (r.kind === 'verdict' && r.voteOpensAt && Date.now() < r.voteOpensAt) {
          await new Promise((res) => setTimeout(res, Math.max(0, r.voteOpensAt! - Date.now()) + 20));
        }
        const uuid = `p-${r.roundId}-${me}`;
        const base = { roundId: r.roundId, clientUuid: uuid };
        let value: any;
        switch (r.kind) {
          case 'pick': case 'verdict': value = { kind: 'pick', target: ids.find((x) => x !== me) }; break;
          case 'shout': value = { kind: 'shout', word: 'chaos' }; break;
          case 'rating': value = { kind: 'rating', trait: r.trait, about: r.about, value: 7 }; break;
          case 'ios': value = { kind: 'ios', about: r.about, value: 5 }; break;
          case 'minigame': value = { kind: 'minigame', score: 60 }; break;
          case 'dare': case 'pair_dare': value = { kind: 'dare', status: 'done' }; break;
          default: value = { kind: 'text', text: `answer from ${me.slice(0, 4)}` };
        }
        const res = await ack(seats[i]!, 'submit', { ...base, value });
        if (!res.ok) rejects.push({ roundId: r.roundId, error: res.error });
      })();
    });
  }
  host.on('reveal', (r: any) => reveals.push(r));
  host.on('finale', () => { finalSeen = true; });

  host.emit('start');
  for (let tick = 0; tick < 1200 && !finalSeen; tick++) await new Promise((r) => setTimeout(r, 50));

  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const log: LogRecord[] = files.flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  const byRound = new Map<string, LogRecord[]>();
  for (const rec of log) { const arr = byRound.get(rec.roundId) ?? []; arr.push(rec); byRound.set(rec.roundId, arr); }

  const roundIds = [...new Set(rounds.map((r) => r.round.roundId))];
  const revealIds = new Set(reveals.map((r) => r.roundId));
  const missing = roundIds.filter((id) => !revealIds.has(id));
  const lies: string[] = [];
  for (const rev of reveals) {
    const recs = (byRound.get(rev.roundId) ?? []).filter((r) => r.decoy !== true);
    if (rev.kind === 'verdict' && rev.slide) {
      const counts = new Map<string, number>();
      for (const rec of recs) if (rec.value.kind === 'pick') counts.set((rec.value as any).target, (counts.get((rec.value as any).target) ?? 0) + 1);
      const total = [...counts.values()].reduce((a, b) => a + b, 0);
      if (rev.slide.numbers.of !== total) lies.push(`verdict ${rev.roundId}: of=${rev.slide.numbers.of} log=${total}`);
      const stated = rev.slide.numbers.votes;
      const actual = counts.get(rev.slide.titleId ?? '') ?? [...counts.values()].sort((a, b) => b - a)[0];
      if (stated !== actual) lies.push(`verdict ${rev.roundId}: votes=${stated} log-top=${actual}`);
    }
    if (rev.kind === 'minigame') {
      const scores = recs.filter((r) => r.value.kind === 'minigame').map((r) => (r.value as any).score);
      for (const item of rev.items ?? []) {
        const m = /^(\d+) taps$/.exec(item.text);
        if (!m) { lies.push(`minigame ${rev.roundId}: unparseable ${item.text}`); continue; }
        if (!scores.includes(Number(m[1]))) lies.push(`minigame ${rev.roundId}: ${item.text} not in log ${scores}`);
      }
    }
    if (rev.kind === 'shout' && rev.items?.[0]) {
      const words = recs.flatMap((r) => r.value.kind === 'shout' ? [(r.value as any).word.trim().toLowerCase()] : []);
      const m = /^(.+) \((\d+)\)$/.exec(rev.items[0].text);
      if (!m) lies.push(`shout ${rev.roundId}: unparseable`);
      else if (words.filter((w) => w === m[1]!.toLowerCase()).length !== Number(m[2])) lies.push(`shout ${rev.roundId}: ${rev.items[0].text} vs log ${words.length}`);
    }
    if (rev.kind === 'spotlight') {
      const subjectRecs = (byRound.get(rev.roundId) ?? []).filter((r) => r.decoy === true);
      if (subjectRecs.length !== 1) lies.push(`spotlight ${rev.roundId}: decoy records=${subjectRecs.length}`);
      for (const item of rev.items ?? []) if (!recs.some((r) => r.value.kind === 'text' && (r.value as any).text === item.text)) lies.push(`spotlight ${rev.roundId}: caption "${item.text}" not in log`);
    }
  }

  console.log(JSON.stringify({
    roundsStarted: roundIds.length,
    roundsWithReveal: roundIds.filter((id) => revealIds.has(id)).length,
    missingReveal: missing,
    revealsToHost: reveals.length,
    rejects,
    displayRounds: displayRounds.length,
    displayReveals: displayReveals.length,
    finale: finalSeen,
    logRecords: log.length,
    decoys: log.filter((r) => r.decoy === true).length,
    lies,
    kinds: [...new Set(rounds.map((r) => r.round.kind))],
  }, null, 2));
  server.close?.();
  process.exit(0);
}
void main();

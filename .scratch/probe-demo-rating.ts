import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { createGameServer } from '../apps/server/src/server.ts';
import { demoAnswerValue } from '../apps/web/src/lib/demoAnswer.ts';

const consent = { age: true, terms: true, revealOptIn: true };
async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'probe-demo-'));
  const server = createGameServer({
    dataDir: dir, graceMs: 30, revealHoldMs: 20, interludeHoldMs: 20, readyGraceMs: 200,
    botDelayMs: [100000, 100000],
    roundTimers: { pick: 600, text: 600, shout: 600, rating: 600, ios: 600, minigame: 600, dare: 600, pair_dare: 600, debrief: 600, spotlight: 700, verdict: 900 },
    verdictDiscussMs: 30,
  });
  const port = await server.listen(0, '127.0.0.1', false);
  const c: Socket = io(`http://127.0.0.1:${port}`, { forceNew: true, transports: ['websocket'], reconnection: false });
  await new Promise<void>(r => c.on('connect', () => r()));
  const errors: any[] = [];
  c.on('error', (e: any) => errors.push(e));
  let view: any;
  c.on('state', (v: any) => { view = v; if (v.ready && !v.ready.includes(v.hostId)) c.emit('ready'); });
  const ack = (ev: string, p: any) => new Promise<any>(r => c.emit(ev, p, r));
  const made = await ack('create', { alias: 'Host', consent, demo: true });
  for (const alias of ['Seat B', 'Seat C', 'Seat D']) await ack('demo_add_player', { alias });
  // keep every puppet manual so we control the answers
  for (const p of view.players) if (p.id !== made.you) c.emit('demo_set_bot_mode', { playerId: p.id, mode: 'manual' });
  c.emit('start');
  let ratingReported = false;
  for (let i = 0; i < 900; i++) {
    await new Promise(r => setTimeout(r, 25));
    const round = view?.round;
    if (ratingReported || round?.kind !== 'rating') continue;
    // answer every puppet seat exactly the way the shipped demo panel does
    for (const p of view.players) {
      if (p.id === made.you) continue;
      const value = demoAnswerValue(round, p.id, view.players)!;
      errors.length = 0;
      c.emit('demo_answer_as', { playerId: p.id, roundId: round.roundId, clientUuid: `demo-${p.id}`, value });
      await new Promise(r => setTimeout(r, 60));
      console.log(`seat ${p.alias} -> value ${JSON.stringify(value)} => ${errors.length ? JSON.stringify(errors.map(e => e.message)) : 'ACCEPTED'}`);
    }
    ratingReported = true;
    const hostValue = { kind: 'rating', trait: round.trait, about: round.about, value: 6 };
    const hostRes = await ack('submit', { roundId: round.roundId, clientUuid: 'host-answer', value: hostValue });
    console.log('host (round.about/trait) =>', JSON.stringify(hostRes));
  }
  c.disconnect(); await server.close(); rmSync(dir, { recursive: true, force: true });
}
void main();

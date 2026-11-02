import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { createGameServer } from '../apps/server/src/server.ts';

const consent = { age: true, terms: true, revealOptIn: true };
const profile = { age: 28, relationship: 'single', partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: 'vibes' };
async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'probe-display-'));
  const server = createGameServer({
    dataDir: dir, graceMs: 30, revealHoldMs: 20, interludeHoldMs: 20, readyGraceMs: 40, botDelayMs: [10, 30],
    roundTimers: { pick: 200, text: 200, shout: 200, rating: 200, ios: 200, minigame: 200, dare: 200, pair_dare: 200, debrief: 200, spotlight: 4000, verdict: 300 },
    verdictDiscussMs: 0,
  });
  const port = await server.listen(0, '127.0.0.1', false);
  const base = `http://127.0.0.1:${port}`;
  const mk = async (): Promise<Socket> => {
    const c: Socket = io(base, { forceNew: true, transports: ['websocket'], reconnection: false });
    await new Promise<void>(r => c.on('connect', () => r()));
    c.on('error', () => {});
    c.on('state', (v: any) => { if (v.ready) c.emit('ready'); });
    return c;
  };
  const ack = (c: Socket, ev: string, p: any) => new Promise<any>(r => c.emit(ev, p, r));
  const host = await mk();
  const made = await ack(host, 'create', { alias: 'Ada', consent, profile });
  const guests = [await mk(), await mk(), await mk()];
  for (const [i, g] of guests.entries()) await ack(g, 'join', { roomCode: made.code, alias: ['Ben', 'Cleo', 'Dara'][i], consent, profile });
  const display = await mk();
  const displayRounds: any[] = []; const subjectRounds: any[] = [];
  display.on('round', (r: any) => displayRounds.push(r));
  await ack(display, 'display_join', { roomCode: made.code });
  let subjectId: string | undefined;
  host.on('round', (r: any) => { if (r.kind === 'spotlight' && !subjectId) subjectId = undefined; });
  const seatRounds = new Map<string, any>();
  for (const [i, s] of [host, ...guests].entries()) s.on('round', (r: any) => seatRounds.set(`${['Ada','Ben','Cleo','Dara'][i]}:${r.roundId}`, r));
  host.emit('start');
  for (let i = 0; i < 300; i++) {
    await new Promise(r => setTimeout(r, 50));
    if (i % 20 === 0) console.log('tick', i, 'display rounds', displayRounds.length, displayRounds.map(r => r.kind).join(','));
    const shown = displayRounds.find(r => r.kind === 'spotlight');
    if (!shown) continue;
    // find which seat's view was replaced by a cover in this round
    const rows: string[] = [];
    for (const [k, r] of seatRounds) if (r.roundId === shown.roundId) rows.push(`${k.split(':')[0]} sees: ${JSON.stringify(r.promptText)}${r.expectsAnswer === false ? ' (idle cover)' : ''}`);
    console.log('DISPLAY sees:', JSON.stringify(shown.promptText));
    console.log(rows.join('\n'));
    break;
  }
  for (const c of [host, ...guests, display]) c.disconnect();
  await server.close(); rmSync(dir, { recursive: true, force: true });
}
void main();

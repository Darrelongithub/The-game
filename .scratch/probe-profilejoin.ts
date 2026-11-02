import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { createGameServer } from '../apps/server/src/server.ts';

const consent = { age: true, terms: true, revealOptIn: true };
const profile = { age: 28, relationship: 'single', partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: 'vibes' };

async function connect(base: string): Promise<Socket> {
  const c: Socket = io(base, { forceNew: true, transports: ['websocket'], reconnection: false });
  await new Promise<void>(r => c.on('connect', () => r()));
  c.on('error', () => {});
  return c;
}
const ack = (c: Socket, ev: string, p: unknown) => new Promise<any>(r => c.emit(ev, p, r));

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'probe-profile-'));
  const s1 = createGameServer({ dataDir: dir });
  const port1 = await s1.listen(0, '127.0.0.1', false);
  const host = await connect(`http://127.0.0.1:${port1}`);
  const made = await ack(host, 'create', { alias: 'Ada', consent, profile });
  const guest = await connect(`http://127.0.0.1:${port1}`);
  const joined = await ack(guest, 'join', { roomCode: made.code, alias: 'Ben', consent, demo: true });
  console.log('profile-less join accepted?', JSON.stringify(joined.ok), joined.error ?? '');
  const meta = readdirSync(dir).find(f => f.endsWith('.meta.json'))!;
  const parsed = JSON.parse(readFileSync(join(dir, meta), 'utf8'));
  console.log('persisted players', JSON.stringify(parsed.players.map((p: any) => ({ id: p.id, hasProfile: p.profile !== undefined }))));
  host.disconnect(); guest.disconnect(); await s1.close();
  // restart with the same dataDir
  const s2 = createGameServer({ dataDir: dir });
  const port2 = await s2.listen(0, '127.0.0.1', false);
  const back = await connect(`http://127.0.0.1:${port2}`);
  const resumed = await ack(back, 'join', { roomCode: made.code, alias: 'Ada', consent, profile });
  const resumedResume = made.secret ? await ack(back, 'join', { roomCode: made.code, alias: 'Ada', consent, resume: { playerId: made.you, secret: made.secret } }) : null;
  console.log('after restart, fresh join:', JSON.stringify(resumed));
  console.log('after restart, resume:', JSON.stringify(resumedResume));
  back.disconnect(); await s2.close();
  rmSync(dir, { recursive: true, force: true });
}
void main();

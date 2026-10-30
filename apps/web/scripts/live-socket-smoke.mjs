// apps/web/scripts/live-socket-smoke.mjs
//   npm run host            # in another terminal (server on :3001 + exported shell)
//   npm run test:live       # this
//
// Optional integration smoke: exercises the SAME socket contract the browser
// transport uses (create → add_bot → start → round → submit) against the real
// server, so a contract drift between apps/web and apps/server shows up here
// instead of on game night. Needs a running server; not part of `npm test`.
import { io } from 'socket.io-client';

const URL = process.env.URL ?? 'http://127.0.0.1:3001';
const log = (...a) => console.log(...a);
let fails = 0;
const ok = (n, c, extra='') => { if (c) log('PASS', n); else { fails++; log('FAIL', n, extra); } };

const s = io(URL, { transports: ['polling', 'websocket'], timeout: 8000 });
const rounds = [];
let lastState = null;
s.on('state', (v) => { lastState = v; });
s.on('round', (r) => { rounds.push(r); });
s.on('error', (e) => log('server error:', e));

const waitFor = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 60)); }
  return null;
};

await new Promise((res, rej) => { s.on('connect', res); s.on('connect_error', rej); setTimeout(rej, 8000); });
ok('socket connects (polling-first)', s.connected);

const created = await new Promise((res) => s.emit('create', { alias: 'Ada', consent: { age: true, terms: true, revealOptIn: true } }, res));
ok('create → ok + room code', created.ok === true && typeof created.code === 'string' && created.code.length === 4, JSON.stringify(created).slice(0,140));
ok('create → secret + snapshot', Boolean(created.secret) && created.state?.phase === 'lobby');

const refused = await new Promise((res) => s.emit('create', { alias: 'X', consent: { age: false, terms: true, revealOptIn: true } }, res));
ok('18+ gate enforced by the server', refused.ok === false);

for (let i = 0; i < 3; i++) s.emit('add_bot');
const four = await waitFor(() => lastState?.players?.length >= 4 ? lastState : null);
ok('add_bot fills the lobby to 4', Boolean(four), `n=${lastState?.players?.length}`);

s.emit('start');
const r1 = await waitFor(() => rounds[0]);
ok('start → a round reaches the phone', Boolean(r1) && typeof r1.promptText === 'string' && r1.closesAt > Date.now(), JSON.stringify(r1 ?? {}).slice(0, 140));
ok('round carries an id + index + kind', Boolean(r1?.roundId) && r1?.index >= 1 && Boolean(r1?.kind));

const others = lastState.players.filter((p) => p.id !== created.you);
let value = { kind: 'text', text: 'Smoke test answer.' };
if (r1.kind === 'pick') value = { kind: 'pick', target: others[0].id };
else if (r1.kind === 'shout') value = { kind: 'shout', word: 'chaos' };
else if (r1.kind === 'rating') value = { kind: 'rating', trait: 'chaos', about: others[0].id, value: 7 };
else if (r1.kind === 'ios') value = { kind: 'ios', about: others[0].id, value: 4 };
else if (r1.kind === 'minigame') value = { kind: 'minigame', score: 30 };
else if (r1.kind === 'dare' || r1.kind === 'pair_dare') value = { kind: 'dare', status: 'done' };
const ack = await new Promise((res) => s.emit('submit', { roundId: r1.roundId, clientUuid: 'live-1', value }, res));
ok('submit → ack ok', ack?.ok === true, JSON.stringify(ack));
const ack2 = await new Promise((res) => s.emit('submit', { roundId: r1.roundId, clientUuid: 'live-1b', value }, res));
ok('duplicate/clientUuid replay handled without crashing', typeof ack2?.ok === 'boolean', JSON.stringify(ack2));

const bad = await new Promise((res) => s.emit('submit', { roundId: r1.roundId, clientUuid: 'live-2', value: { kind: 'pick', target: created.you } }, res));
ok('self-pick refused by the server', bad?.ok === false, JSON.stringify(bad));

s.close();
log(fails === 0 ? '\nLIVE SMOKE PASSED ✅' : `\n${fails} LIVE SMOKE FAILURES ❌`);
process.exit(fails === 0 ? 0 : 1);

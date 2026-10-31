// apps/web/scripts/socket-transport.test.ts
//   npx -y tsx --tsconfig scripts/tsconfig.test.json --test scripts/socket-transport.test.ts
//
// The browser transport against the REAL game server: a phone joins, the
// laptop binds with its token, an answer goes out, and a reloaded tab
// reclaims its seat.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGameServer } from '../../server/src/server.ts';
import { SocketTransport } from '../src/lib/socketTransport';

const waitFor = async (condition: () => boolean, label: string) => {
  const end = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

const PROFILE = {
  age: 28,
  gender: 'woman' as const,
  sexuality: 'straight' as const,
  attractedTo: 'women' as const,
};

test('the transport joins, binds the host, and resumes', { timeout: 20000 }, async t => {
  const server = createGameServer({});
  const port = await server.listen(0, '127.0.0.1', false);
  const oldUrl = process.env.NEXT_PUBLIC_SERVER_URL;
  process.env.NEXT_PUBLIC_SERVER_URL = `http://127.0.0.1:${port}`;
  const storage = new Map<string, string>();
  const fakeWindow = { sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } };
  const fakeDocument = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  Object.assign(globalThis, { window: fakeWindow, document: fakeDocument });

  const transport = new SocketTransport();
  const errors: string[] = [];
  const states: unknown[] = [];
  transport.setHandlers({
    onError: error => errors.push(error.code),
    onState: view => states.push(view),
  });
  t.after(async () => {
    transport.disconnect();
    await server.close();
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    if (oldUrl === undefined) delete process.env.NEXT_PUBLIC_SERVER_URL;
    else process.env.NEXT_PUBLIC_SERVER_URL = oldUrl;
  });

  // ---- the laptop binds with its token — no code to type ----
  const room = server.rooms.nightRoom!;
  const bound = await transport.hostJoin(room.hostToken);
  assert.equal(bound.ok, true, 'the host token binds the room');

  // ---- a phone joins with the code from the QR ----
  const joined = await transport.join({
    roomCode: room.code,
    alias: 'Wanjiru',
    consent: { age: true, terms: true },
    profile: PROFILE,
  });
  assert.ok(joined.ok && joined.you && joined.secret, 'the phone joins');
  assert.ok(storage.get('reveal.session'), 'the seat is remembered for a reload');

  // ---- the join is refused for an underage player ----
  const refused = await transport.join({
    roomCode: room.code,
    alias: 'Kid',
    consent: { age: true, terms: true },
    profile: { ...PROFILE, age: 16 },
  });
  assert.equal(refused.ok, false, '18+ is enforced on the server');

  // ---- a reloaded tab reclaims its seat ----
  const before = states.length;
  transport.resume();
  await waitFor(() => states.length > before, 'the resumed snapshot');
  assert.deepEqual(errors, [], 'a resume does not error');
  assert.equal(server.rooms.nightRoom!.players.size, 1, 'a reload does not take a second seat');

  transport.disconnect();
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('socket transport coalesces resume, detaches visibility listener, and reports rejected dare passes', { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'reveal-transport-'));
  const server = createGameServer({ dataDir: dir });
  const port = await server.listen(0, '127.0.0.1', false);
  const oldUrl = process.env.NEXT_PUBLIC_SERVER_URL;
  process.env.NEXT_PUBLIC_SERVER_URL = `http://127.0.0.1:${port}`;
  const storage = new Map<string, string>();
  const fakeWindow = { sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } };
  const fakeDocument = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  Object.assign(globalThis, { window: fakeWindow, document: fakeDocument });
  let joins = 0;
  server.io.on('connection', socket => socket.onAny(event => { if (event === 'join') joins++; }));
  const transport = new SocketTransport();
  const errors: string[] = [];
  transport.setHandlers({ onError: error => errors.push(error.code) });
  t.after(async () => {
    transport.disconnect(); await server.close(); rmSync(dir, { recursive: true, force: true });
    delete (globalThis as any).window; delete (globalThis as any).document;
    if (oldUrl === undefined) delete process.env.NEXT_PUBLIC_SERVER_URL; else process.env.NEXT_PUBLIC_SERVER_URL = oldUrl;
  });
  const created = await transport.create('Host', { age: true, terms: true, revealOptIn: true });
  assert.ok(created.ok && created.secret);
  transport.resume(); transport.resume(); fakeDocument.dispatchEvent(new Event('visibilitychange'));
  await waitFor(() => joins === 1 && JSON.parse(storage.get('reveal.session') ?? '{}').secret !== created.secret, 'resume rotation');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(joins, 1); assert.deepEqual(errors, []);
  const rejected = await transport.darePass({ roundId: 'not-a-live-round', reason: 'Not right now.' });
  assert.equal(rejected.ok, false, 'the acknowledged submit must not claim a rejected pass succeeded');
  assert.equal((await transport.darePass({ roundId: 'x', reason: '  ' })).ok, false);
  transport.disconnect(); fakeDocument.dispatchEvent(new Event('visibilitychange'));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(joins, 1, 'unmounted transport must not rejoin');
});

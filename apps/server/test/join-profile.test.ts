// apps/server/test/join-profile.test.ts
// THE PROFILE GATE ON `join` (and why it is a persistence invariant).
//
// Spec §1: joining is alias + consent, and the 18+ profile is collected at the
// door. `JoinRequest` has no `demo` field (only `create` does), so the server must
// not accept a profile-less seat: `Player.profile` and `RoomMeta.profiles` are
// non-optional, and `restore()` revalidates EVERY persisted player with
// `validProfile` — one undefined profile makes it drop the room, which silently
// destroys the night for everyone the next time the server restarts.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, JoinReply, ServerToClientEvents } from "../../../packages/shared/src/contracts.ts";
import { createGameServer, type GameServer } from "../src/server.ts";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const consent = { age: true, terms: true, revealOptIn: true };
const profile = { age: 28, relationship: "single" as const, partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: "vibes" as const };
const limit = <T>(promise: Promise<T>, ms = 5_000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});

test("a join without a profile is refused, so the room stays restorable", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reveal-join-profile-"));
  const servers: GameServer[] = [];
  const sockets: Client[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    for (const server of servers) await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const start = async (): Promise<string> => {
    const server = createGameServer({ dataDir: dir });
    servers.push(server);
    const port = await server.listen(0, "127.0.0.1", false);
    return `http://127.0.0.1:${port}`;
  };
  const connect = async (base: string): Promise<Client> => {
    const client: Client = io(base, { forceNew: true, transports: ["websocket"], reconnection: false, autoConnect: false });
    client.on("error", () => {});
    sockets.push(client);
    const opened = new Promise<void>((resolve) => client.on("connect", () => resolve()));
    client.connect(); await limit(opened); return client;
  };
  const create = (client: Client, alias: string): Promise<JoinReply & { code?: string }> =>
    new Promise((resolve) => client.emit("create", { alias, consent, profile }, resolve));
  const sendJoin = (client: Client, payload: unknown): Promise<JoinReply> =>
    new Promise((resolve) => client.emit("join", payload as never, resolve));

  const host = await connect(await start());
  const made = await create(host, "Host");
  assert.ok(made.ok && made.code && made.secret && made.you);

  // A crafted frame cannot buy a seat without the 18+ profile — not even by
  // borrowing `create`'s demo escape, which is not part of JoinRequest.
  const draft = await connect(await start());
  assert.equal((await sendJoin(draft, { roomCode: made.code, alias: "Draft", consent, demo: true })).ok, false, "a real room demands the profile on join");
  assert.equal((await sendJoin(draft, { roomCode: made.code, alias: "Draft", consent })).ok, false, "alias + consent alone is not enough to take a seat");

  const guest = await connect(await start());
  assert.ok((await sendJoin(guest, { roomCode: made.code, alias: "Guest", consent, profile })).ok, "a complete join still works");

  // The night must survive a restart: every persisted player revalidates.
  const resumed = await connect(await start());
  const back = await sendJoin(resumed, { roomCode: made.code, alias: "Host", consent, resume: { playerId: made.you!, secret: made.secret! } });
  assert.ok(back.ok, "the room (and the seat) is still there after a restart");
  assert.equal(back.you, made.you);
});

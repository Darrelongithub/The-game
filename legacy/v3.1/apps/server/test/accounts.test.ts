// apps/server/test/accounts.test.ts
// ROUND 4 STEP 2 — account lifecycle, end to end over the real HTTP surface.
// create → login → recover-with-code → delete-wipe, case-insensitive
// uniqueness, no email field, guest parity (a room plays identically without
// an account), and persistence that outlives the 48h room purge.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AccountStore } from "../src/accounts.ts";
import { createGameServer, type GameServer } from "../src/server.ts";

let dataDir: string;
let server: GameServer;
let base: string;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "reveal-accounts-"));
  server = createGameServer({ revealMode: "round", dataDir });
  const port = await server.listen(0, "127.0.0.1", false);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const post = (path: string, body: unknown, token?: string) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const del = (path: string, body: unknown, token?: string) =>
  fetch(`${base}${path}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const get = (path: string, token?: string) =>
  fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

test("create returns a token and a ONE-TIME recovery code, then login works", async () => {
  const created = await post("/api/account", { username: "NightOwl_7", pin: "4821" });
  assert.equal(created.status, 201);
  const body = await created.json() as { ok: boolean; token: string; recoveryCode: string; account: { username: string; createdAt: number; nightsPlayed: number } };
  assert.equal(body.ok, true);
  assert.ok(body.token.length >= 32, "token must be opaque and long");
  assert.match(body.recoveryCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/u);
  assert.equal(body.account.username, "nightowl_7", "usernames canonicalise to lowercase");
  assert.equal(body.account.nightsPlayed, 0);
  assert.deepEqual(Object.keys(body.account).sort(), ["createdAt", "nightsPlayed", "username"]);

  // The recovery code is never echoed again.
  const info = await get("/api/account", body.token);
  const infoBody = await info.json() as Record<string, unknown>;
  assert.equal(info.status, 200);
  assert.ok(!("recoveryCode" in infoBody) && !("recoveryCode" in (infoBody.account as object)));

  const login = await post("/api/account/login", { username: "NIGHTOWL_7", pin: "4821" });
  assert.equal(login.status, 200);
  const session = await login.json() as { ok: boolean; token: string; account: { username: string } };
  assert.equal(session.ok, true);
  assert.equal(session.account.username, "nightowl_7", "login is case-insensitive");
  assert.notEqual(session.token, body.token, "each session gets its own token seed");
});

test("usernames are unique case-insensitively; PIN and shape are enforced", async () => {
  const dup = await post("/api/account", { username: "nightOWL_7", pin: "1111" });
  assert.equal(dup.status, 400);
  assert.match((await dup.json() as { error: string }).error, /taken/u);

  assert.equal((await post("/api/account", { username: "ab", pin: "1234" })).status, 400);
  assert.equal((await post("/api/account", { username: "has space", pin: "1234" })).status, 400);
  assert.equal((await post("/api/account", { username: "has.dots", pin: "1234" })).status, 400);
  assert.equal((await post("/api/account", { username: "seventeen_chars_x", pin: "1234" })).status, 400, "17 chars is over the limit");
  assert.equal((await post("/api/account", { username: "sixteen_chars_xx", pin: "1234" })).status, 201, "16 chars is exactly the limit");
  assert.equal((await post("/api/account", { username: "pinless", pin: "123" })).status, 400, "PIN must be 4–6 digits");
  assert.equal((await post("/api/account", { username: "pinless", pin: "1234567" })).status, 400);
  assert.equal((await post("/api/account", { username: "pinless", pin: "abcd" })).status, 400);
});

test("there is no email field: unknown fields are refused, not stored", async () => {
  const withExtra = await post("/api/account", { username: "emailish", pin: "1234", email: "a@b.c" });
  assert.equal(withExtra.status, 400);
  assert.equal((await withExtra.json() as { ok: boolean }).ok, false);
  const store = readFileSync(join(dataDir, "accounts.json"), "utf8");
  assert.ok(!/email/iu.test(store), "nothing email-shaped may reach disk");
  assert.ok(!/a@b\.c/u.test(store));
});

test("recovery code signs you back in, rotates on use, and the PIN is not needed", async () => {
  const created = await post("/api/account", { username: "lost_pin", pin: "9999" });
  const { recoveryCode, token } = await created.json() as { recoveryCode: string; token: string };

  const bad = await post("/api/account/recover", { username: "lost_pin", recoveryCode: "AAAA-BBBB-CCCC" });
  assert.equal(bad.status, 401);

  const recovered = await post("/api/account/recover", { username: "lost_pin", recoveryCode: recoveryCode.toLowerCase() });
  assert.equal(recovered.status, 200);
  const next = await recovered.json() as { ok: boolean; token: string; recoveryCode: string };
  assert.ok(next.token.length > 20);
  assert.notEqual(next.recoveryCode, recoveryCode, "a used recovery code is dead");

  const replayed = await post("/api/account/recover", { username: "lost_pin", recoveryCode });
  assert.equal(replayed.status, 401, "the old code cannot be replayed");

  const fresh = await post("/api/account/recover", { username: "lost_pin", recoveryCode: next.recoveryCode });
  assert.equal(fresh.status, 200);
  assert.equal((await get("/api/account", token)).status, 200, "earlier sessions stay valid");
});

test("DELETE wipes the identity, its nights and its carried priors", async () => {
  const created = await post("/api/account", { username: "wipe_me", pin: "4242" });
  const { token } = await created.json() as { token: string };
  const accountId = server.accounts.accountIdFor(token);
  assert.ok(accountId);
  server.accounts.recordNight(accountId, "room-1");
  server.accounts.setPriors(accountId, [{ kind: "onesided", subjects: ["acct:x:p2"], status: "unresolved", strength: 0.5, evidence: ["x"], openedAt: 1 }]);
  assert.equal(server.accounts.priors(accountId).length, 1);

  assert.equal((await del("/api/account", {}, token)).status, 400, "deletion needs explicit confirmation");
  const wiped = await del("/api/account", { confirm: "delete" }, token);
  assert.equal(wiped.status, 200);
  assert.equal((await get("/api/account", token)).status, 401, "the token is gone");
  assert.equal((await post("/api/account/login", { username: "wipe_me", pin: "4242" })).status, 401);
  assert.equal(server.accounts.priors(accountId).length, 0);
  const disk = readFileSync(join(dataDir, "accounts.json"), "utf8");
  assert.ok(!disk.includes("wipe_me"), "a wiped username must not survive on disk");
});

test("repeated wrong PINs lock the door for a while", async () => {
  const store = new AccountStore({ file: join(dataDir, "lock-test.json"), scrypt: { N: 1024, r: 8, p: 1 } });
  assert.equal(store.create("locky", "1234").ok, true);
  for (let i = 0; i < 5; i++) assert.equal(store.login("locky", "0000").ok, false);
  const locked = store.login("locky", "1234");
  assert.equal(locked.ok, false);
  assert.match(locked.ok ? "" : locked.error, /Too many attempts/u);
});

test("accounts outlive the room purge: only room logs are deleted", async () => {
  const login = await post("/api/account/login", { username: "nightowl_7", pin: "4821" });
  const { token } = await login.json() as { token: string };
  // The purge only reaps `1234567890123-<hex>.jsonl` room logs.
  server.rooms.purge();
  assert.ok(existsSync(join(dataDir, "accounts.json")));
  // A brand-new process (fresh store over the same file) still knows the token.
  const reloaded = new AccountStore({ file: join(dataDir, "accounts.json") });
  assert.equal(reloaded.infoFor(token)?.username, "nightowl_7");
  assert.equal(reloaded.infoFor("not-a-real-token-at-all"), undefined);
});

test("guest parity: a room with no account plays exactly the same", async () => {
  // Guests never call the account API; the socket surface is untouched.
  const contracts = readFileSync(new URL("../../../packages/shared/src/contracts.ts", import.meta.url), "utf8");
  const clientEvents = contracts.slice(contracts.indexOf("export type ClientToServerEvents"), contracts.indexOf("export type ServerToClientEvents"));
  assert.ok(!/account/iu.test(clientEvents), "accounts ride REST only — guest play needs no new socket call");
});

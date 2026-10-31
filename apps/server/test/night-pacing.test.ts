import assert from "node:assert/strict";
import { test } from "node:test";
import { ROUND_TIMERS_MS, INTERLUDE_HOLD_MS, GRACE_MS } from "../../../packages/shared/src/contracts.ts";

test("night pacing defaults are hard ceilings", () => {
  assert.equal(ROUND_TIMERS_MS.pick, 25_000);
  assert.equal(ROUND_TIMERS_MS.shout, 25_000);
  assert.equal(ROUND_TIMERS_MS.rating, 25_000);
  assert.equal(ROUND_TIMERS_MS.text, 60_000);
  assert.ok(INTERLUDE_HOLD_MS <= 4_000);
  assert.equal(GRACE_MS, 0);
});

test("a scripted finale night is materially faster than waiting at each ready gate", { timeout: 15000 }, async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { io } = await import("socket.io-client");
  const { createGameServer } = await import("../src/server.ts");
  const run = async (revealMode: "round" | "finale") => {
    const dir = mkdtempSync(join(tmpdir(), "pacing-"));
    const server = createGameServer({ dataDir: dir, revealMode, readyGraceMs: 60, revealHoldMs: 1, interludeHoldMs: 1, botDelayMs: [1, 2], verdictDiscussMs: 0, roundTimers: { spotlight: 300, verdict: 300 } });
    const port = await server.listen(0, "127.0.0.1", false);
    const socket = io(`http://127.0.0.1:${port}`, { reconnection: false, autoConnect: false });
    try {
      await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); socket.connect(); });
      const made = await new Promise<any>(resolve => socket.emit("create", { alias: "Host", consent: { age: true, terms: true, revealOptIn: true }, profile: { age: 28, relationship: "single", partnersToDate: 0, longestMonths: 0, crushingHere: false, tonight: "vibes" } }, resolve));
      for (let i = 0; i < 3; i++) socket.emit("add_bot");
      const answered = new Set<string>();
      socket.on("round", (r: any) => {
        if (r.youSubmitted || r.expectsAnswer === false || answered.has(r.roundId) || (r.onlyPlayers && !r.onlyPlayers.includes(made.you))) return;
        answered.add(r.roundId);
        const value = r.kind === "pick" || r.kind === "verdict" ? { kind: "pick", target: "p2" }
          : r.kind === "text" || r.kind === "spotlight" || r.kind === "debrief" ? { kind: "text", text: "A synthetic answer for this room." }
          : r.kind === "shout" ? { kind: "shout", word: "vibes" }
          : r.kind === "rating" ? { kind: "rating", trait: r.trait, about: r.about, value: 5 }
          : r.kind === "ios" ? { kind: "ios", about: r.about, value: 5 }
          : r.kind === "minigame" ? { kind: "minigame", score: 10 } : { kind: "dare", status: "done" };
        socket.emit("submit", { roundId: r.roundId, clientUuid: r.roundId, value }, () => {});
      });
      const done = new Promise<void>(resolve => socket.once("finale", resolve));
      const started = Date.now(); socket.emit("start"); await done; return Date.now() - started;
    } finally { socket.disconnect(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
  };
  const slow = await run("round"), fast = await run("finale");
  assert.ok(fast < slow * .8, `finale mode ${fast}ms vs ready-gated ${slow}ms`);
});

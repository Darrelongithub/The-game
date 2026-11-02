// The `live/` bank category (ROUND 3): spotlight + verdict seeds and the decoy
// cover pool. These never enter loadBank() — the server's live-moment planner
// schedules them — so they get their own checks.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { HEAT_ORDER } from "../../shared/src/contracts.ts";
import {
  DECOYS,
  RAW_LIVE,
  SPOTLIGHT_IDLE_LINE,
  liveCounts,
  liveKindInPhase,
  livePrompt,
  liveSeeds,
  type LiveSeed,
} from "../src/bank/live/index.ts";

const ALL: LiveSeed[] = [...RAW_LIVE.spotlight, ...RAW_LIVE.verdict];

test("live bank: both kinds are seeded for every phase the spec schedules them in", () => {
  for (const phase of HEAT_ORDER) {
    assert.ok(liveSeeds("spotlight", phase, { spicy: true }).length > 0, `no spotlight for ${phase}`);
  }
  for (const phase of ["spicy", "deep", "dare"] as const) {
    assert.ok(liveSeeds("verdict", phase, { spicy: true }).length > 0, `no verdict for ${phase}`);
  }
  // spotlight runs from warmup, verdict only from spicy (spec §3 flow).
  assert.equal(liveKindInPhase("spotlight", "warmup"), true);
  assert.equal(liveKindInPhase("verdict", "warmup"), false);
  assert.equal(liveKindInPhase("verdict", "spicy"), true);
});

test("live bank: ids are unique and every row is shaped for the engine", () => {
  const ids = ALL.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate live id");
  assert.equal(new Set(DECOYS.map((d) => d.id)).size, DECOYS.length, "duplicate decoy id");
  for (const seed of ALL) {
    assert.ok(seed.text.trim().length > 0);
    assert.ok(HEAT_ORDER.includes(seed.phase), `${seed.id} phase ${seed.phase}`);
    // data-or-dead: every live seed measures something.
    assert.ok(seed.measures.length > 0, `${seed.id} measures nothing`);
    assert.ok(seed.coding !== "neutral", `${seed.id} must be coded`);
    assert.equal(seed.kind === "spotlight" ? Boolean(seed.cluster) : typeof seed.couple === "boolean", true,
      `${seed.id} missing cluster/couple flag`);
  }
});

test("spotlight texts carry exactly one {S} and no other placeholder", () => {
  for (const seed of RAW_LIVE.spotlight) {
    assert.equal((seed.text.match(/\{S\}/g) ?? []).length, 1, `${seed.id} must have one {S}`);
    assert.equal(/[{}]/u.test(seed.text.replace(/\{S\}/g, "")), false, `${seed.id} has an invented placeholder`);
    assert.ok(seed.text.length <= 160, `${seed.id} too long to display`);
  }
});

test("verdict texts are prompts, not questions with a target baked in", () => {
  for (const seed of RAW_LIVE.verdict) {
    assert.equal(/[{}]/u.test(seed.text), false, `${seed.id} must not need a subject`);
    assert.ok(seed.text.startsWith("THE VERDICT:"), `${seed.id} should look like a verdict`);
  }
});

test("the spicy tier gates only the marked rows", () => {
  const tamed = liveCounts({ spicy: false });
  const full = liveCounts({ spicy: true });
  assert.ok(full.spotlight >= tamed.spotlight && full.verdict >= tamed.verdict);
  assert.ok(full.spotlight > tamed.spotlight, "expected at least one spicy-only spotlight");
  for (const phase of HEAT_ORDER) {
    for (const seed of liveSeeds("spotlight", phase, { spicy: false })) assert.equal(seed.spicy, false);
    if (phase !== "warmup") for (const seed of liveSeeds("verdict", phase, { spicy: false })) assert.equal(seed.spicy, false);
  }
});

test("used ids drop out, so live moments never repeat in a night", () => {
  const pool = liveSeeds("spotlight", "deep", { spicy: true });
  const used = new Set(pool.map((s) => s.id));
  assert.equal(liveSeeds("spotlight", "deep", { spicy: true, excludeIds: used }).length, 0);
});

test("every seed converts to a Prompt the server can carry", () => {
  for (const seed of ALL) {
    const prompt = livePrompt(seed);
    assert.equal(prompt.id, seed.id);
    assert.equal(prompt.kind, seed.kind);
    assert.equal(prompt.source, "bank");
    assert.deepEqual(prompt.measures, seed.measures);
  }
});

test("decoys read like ordinary throwaway questions and give nothing away", () => {
  assert.ok(DECOYS.length >= 4, "the brief asks for a decoy pool of at least four");
  for (const decoy of DECOYS) {
    assert.ok(decoy.text.trim().length > 0 && decoy.text.length <= 120);
    // A decoy must not mention the room, a player or the live moment.
    assert.equal(/[{}]/u.test(decoy.text), false, `${decoy.id} has a placeholder`);
    assert.equal(/\b(spotlight|caption|verdict)\b/iu.test(decoy.text), false, `${decoy.id} gives the game away`);
  }
  assert.ok(SPOTLIGHT_IDLE_LINE.length > 0);
});

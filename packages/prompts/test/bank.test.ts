// packages/prompts/test/bank.test.ts
// The bank is the ship-blocker: it must carry a whole night with ZERO API keys.
import test from "node:test";
import assert from "node:assert/strict";
import {
  BANK_PHASES,
  PHASE_KINDS,
  RAW_BANK,
  UNHINGED_IDS,
  bankCounts,
  bankForPhase,
  checkBanned,
  checkDataOrDead,
  checkHardBlocked,
  loadBank,
  maxPlaceholderIndex,
  selectFromBank,
  spicyTierEnabled,
  badPlaceholder,
  traitOfPrompt,
  type PromptPhase,
} from "../src/index.ts";

const SEED_IDS = [
  "w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8", "w9", "w10",
  "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10",
  "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10",
  "dd1", "dd2", "dd3", "dd4", "dd5", "dd6", "dd7", "dd8", "dd9", "dd10",
];

const U_IDS = Array.from({ length: 27 }, (_, i) => `u${i + 1}`);

test("≥15 usable prompts per phase with SPICY_TIER on", () => {
  const counts = bankCounts({ spicy: true });
  for (const phase of BANK_PHASES) {
    assert.ok(counts[phase] >= 15, `${phase} has only ${counts[phase]}`);
  }
});

test("SPICY_TIER off drops u1–u27 and still leaves a full night", () => {
  const tame = loadBank({ spicy: false });
  assert.equal(tame.filter((p) => p.id.startsWith("u")).length, 0);
  const counts = bankCounts({ spicy: false });
  for (const phase of BANK_PHASES) {
    assert.ok(counts[phase] >= 15, `${phase} has only ${counts[phase]} without the unhinged tier`);
  }
});

test("every research-brief seed is present exactly once", () => {
  const bank = loadBank({ spicy: true });
  const ids = bank.map((p) => p.id);
  for (const id of SEED_IDS) assert.equal(ids.filter((x) => x === id).length, 1, `missing/duplicated ${id}`);
  assert.equal(new Set(ids).size, ids.length, "bank ids are not unique");
});

test("ALL of the unhinged tier u1–u27 is in the spicy bank and behind the gate", () => {
  const spicy = loadBank({ spicy: true }).map((p) => p.id);
  const tame = loadBank({ spicy: false }).map((p) => p.id);
  for (const id of U_IDS) {
    assert.ok(spicy.includes(id), `missing ${id} with SPICY_TIER on`);
    assert.ok(!tame.includes(id), `${id} leaked with SPICY_TIER off`);
  }
  assert.deepEqual([...UNHINGED_IDS].sort(), U_IDS.sort());
});

test("every bank entry passes the data-or-dead rule (coding + measures + directed)", () => {
  for (const prompt of loadBank({ spicy: true })) {
    const verdict = checkDataOrDead({
      kind: prompt.kind,
      text: prompt.text,
      coding: prompt.coding,
      measures: prompt.measures,
      asksTarget: prompt.asksTarget,
    });
    assert.ok(verdict.ok, `${prompt.id} fails data-or-dead: ${verdict.reason} ${verdict.detail ?? ""}`);
    assert.ok(Array.isArray(prompt.measures) && prompt.measures.length > 0, `${prompt.id} has no measures`);
  }
});

test("every bank entry has the full Prompt shape and a legal kind for its phase", () => {
  for (const prompt of loadBank({ spicy: true })) {
    assert.equal(prompt.source, "bank", `${prompt.id} source`);
    assert.ok(BANK_PHASES.includes(prompt.phase), `${prompt.id} phase`);
    assert.ok(PHASE_KINDS[prompt.phase].includes(prompt.kind), `${prompt.id} kind ${prompt.kind} in ${prompt.phase}`);
    assert.equal(typeof prompt.asksTarget, "boolean", `${prompt.id} asksTarget`);
    assert.ok(prompt.text.length >= 20 && prompt.text.length <= 200, `${prompt.id} length ${prompt.text.length}`);
  }
});

test("placeholders are {P1}..{P11} only, and never beyond the roster", () => {
  for (const prompt of loadBank({ spicy: true })) {
    assert.equal(badPlaceholder(prompt.text), null, `${prompt.id} has an invalid placeholder`);
    assert.ok(maxPlaceholderIndex(prompt.text) <= 11, `${prompt.id} placeholder out of range`);
  }
});

/**
 * The hard-block list is the PROVIDER guardrail (spec §6: what may leave a
 * model). The handwritten bank is not model output — it is authored, reviewed
 * adult content for a private 18+ room, and the repo owner approved the
 * CONFESS canon verbatim, including this line. The allowlist stays tiny and
 * exact: one seed, one string, asserted below.
 */
const OWNER_APPROVED_CANON: Record<string, string> = {
  sc1: "Have you ever sent a nude to someone in this room?",
};

test("no bank entry trips a banned pattern or an unapproved hard block", () => {
  for (const prompt of loadBank({ spicy: true })) {
    assert.equal(checkBanned(prompt.text), null, `${prompt.id} hits banned pattern`);
    const approved = OWNER_APPROVED_CANON[prompt.id];
    if (approved !== undefined) {
      assert.equal(prompt.text, approved, `${prompt.id} drifted from the approved canon line`);
      continue;
    }
    assert.equal(checkHardBlocked(prompt.text), null, `${prompt.id} hits a hard block`);
  }
  // The allowlist is an exception, never a habit.
  assert.ok(Object.keys(OWNER_APPROVED_CANON).length <= 2);
});

test("every rating prompt names a real evaluative trait", () => {
  const ratings = loadBank({ spicy: true }).filter((p) => p.kind === "rating");
  assert.ok(ratings.length >= 8, "expected a healthy number of rating prompts");
  for (const prompt of ratings) {
    const trait = traitOfPrompt(prompt);
    assert.ok(trait, `${prompt.id} is a rating with no readable trait`);
    assert.ok(["loyalty", "chaos", "reliability", "warmth", "honesty", "spice"].includes(trait!));
  }
});

test("the dare phase always offers pair_dare and debrief (spectator + private rounds)", () => {
  for (const spicy of [true, false]) {
    const kinds = new Set(bankForPhase("dare", { spicy }).map((p) => p.kind));
    assert.ok(kinds.has("pair_dare"), "pair_dare missing");
    assert.ok(kinds.has("debrief"), "debrief missing");
    assert.ok(kinds.has("dare"), "solo dares missing");
  }
});

test("host-facing variety: every phase spans at least 3 round kinds", () => {
  for (const phase of BANK_PHASES) {
    const kinds = new Set(bankForPhase(phase, { spicy: true }).map((p) => p.kind));
    assert.ok(kinds.size >= 3, `${phase} only has ${[...kinds].join(",")}`);
  }
});

test("bank is deterministic across loads (same ids, same order)", () => {
  const a = loadBank({ spicy: true }).map((p) => p.id);
  const b = loadBank({ spicy: true }).map((p) => p.id);
  assert.deepEqual(a, b);
});

test("selection: excludes used ids, honours the player count, never repeats", () => {
  const picked = selectFromBank("warmup", 4, { playerCount: 4, excludeIds: ["w1", "w2"] });
  assert.equal(picked.length, 4);
  assert.ok(!picked.some((p) => p.id === "w1" || p.id === "w2"));
  assert.equal(new Set(picked.map((p) => p.id)).size, 4);
  // A 4-player room must never be handed a {P7} prompt.
  for (const phase of BANK_PHASES) {
    for (const prompt of selectFromBank(phase, 15, { playerCount: 4 })) {
      assert.ok(maxPlaceholderIndex(prompt.text) <= 4, `${prompt.id} needs more than 4 players`);
    }
  }
});

test("selection spreads round kinds before repeating one", () => {
  const picked = selectFromBank("warmup", 5, { playerCount: 6 });
  const kinds = new Set(picked.map((p) => p.kind));
  assert.ok(kinds.size >= 4, `expected a spread of kinds, got ${[...kinds].join(",")}`);
});

test("selection returns what exists when a phase is exhausted (never throws)", () => {
  const all = bankForPhase("deep", { spicy: false }).map((p) => p.id);
  assert.equal(selectFromBank("deep", 99, { spicy: false, playerCount: 11 }).length, all.length);
  assert.equal(selectFromBank("deep", 5, { spicy: false, playerCount: 11, excludeIds: all }).length, 0);
});

test("phase files match their declared phase", () => {
  for (const phase of BANK_PHASES as readonly PromptPhase[]) {
    for (const row of RAW_BANK.phases[phase]) assert.equal(row.phase, phase, `${row.id} in wrong file`);
  }
  for (const row of RAW_BANK.unhinged) assert.ok(["spicy", "deep", "dare"].includes(row.phase), `${row.id} phase`);
});

test("SPICY_TIER env override is respected", () => {
  assert.equal(spicyTierEnabled({}), true);
  assert.equal(spicyTierEnabled({ SPICY_TIER: "true" }), true);
  assert.equal(spicyTierEnabled({ SPICY_TIER: "false" }), false);
  assert.equal(spicyTierEnabled({ SPICY_TIER: " OFF " }), false);
});

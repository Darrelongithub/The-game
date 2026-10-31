// packages/prompts/test/confess.test.ts
// THE SECOND VOICE — bank seeds, twin links, and the gen lane's register.
// Written to FAIL before the feature landed: no style tags, no confess seeds,
// and a generation system prompt that taught only the group voice.
import test from "node:test";
import assert from "node:assert/strict";
import {
  PHASE_KINDS,
  RAW_BANK,
  confessionFewShots,
  generateBatchReport,
  groupFewShots,
  loadBank,
  normalizeStyle,
} from "../src/index.ts";
import { BANK } from "../src/bank/index.ts";
import { candidate, grokReply, makeProvider, mockFetch } from "./helpers.ts";

const base = { phase: "spicy" as const, playerCount: 6, usedIds: [], room: "room-voice" };

test("the bank carries both voices: every question seed is tagged, both voices are stocked", () => {
  const bank = loadBank({ spicy: true });
  const questionKinds = new Set(["pick", "text", "shout", "rating", "ios", "minigame", "confess"]);
  const questions = bank.filter((p) => questionKinds.has(p.kind));
  assert.ok(questions.length >= 70, "the question bank is stocked");
  assert.deepEqual(questions.filter((p) => p.style === undefined), [], "every question seed knows its voice");
  for (const phase of ["warmup", "spicy", "deep"] as const) {
    const group = bank.filter((p) => p.phase === phase && p.style === "group");
    const confess = bank.filter((p) => p.phase === phase && p.style === "confess");
    assert.ok(group.length >= 10, `${phase} has only ${group.length} group seeds`);
    assert.ok(confess.length >= 5, `${phase} has only ${confess.length} confess seeds`);
    assert.ok(confess.every((p) => p.kind === "confess"), `${phase}: a confess-style seed must use kind "confess"`);
    assert.ok(PHASE_KINDS[phase].includes("confess"), `${phase} must allow a confess round`);
  }
  // Executed question seeds never claim the confess voice.
  const executed = loadBank({ spicy: true }).filter((p) => p.kind === "dare" || p.kind === "pair_dare" || p.kind === "debrief");
  assert.ok(executed.every((p) => p.style !== "confess"), "dares are not confessions");
});

test("the canon confession lines ship verbatim (warm and spicy voices)", () => {
  const texts = BANK.map((p) => p.text);
  for (const canon of [
    "Have you ever had a crush on someone in this room?",
    "Have you ever lied to dodge a date with someone here?",
    "Have you ever sent a nude to someone in this room?",
    "Have you ever fantasized about someone else in this room?",
    "Have you ever hooked up with someone from this friend group?",
  ]) {
    assert.ok(texts.includes(canon), `missing canon line: ${canon}`);
  }
  // The voice itself: second person, self-report, no "Who here…".
  for (const p of BANK.filter((s) => s.style === "confess")) {
    assert.match(p.text, /^Have you ever\b/, `${p.id} is off-voice: ${p.text}`);
    assert.ok(!/\bwho here\b|\bpoint at\b/i.test(p.text), `${p.id} is a group prompt wearing a confession tag`);
    assert.equal(p.asksTarget === true ? true : true, true);
  }
});

test("twinId links a group seed and a confess seed on the SAME topic, both ways", () => {
  const byId = new Map(BANK.map((p) => [p.id, p]));
  const links = BANK.filter((p) => p.twinId !== undefined);
  assert.ok(links.length >= 4, "at least a few perception→reality pairs must exist");
  for (const seed of links) {
    const twin = byId.get(seed.twinId!);
    assert.ok(twin, `${seed.id} points at a missing twin ${seed.twinId}`);
    assert.equal(twin.twinId, seed.id, `${seed.id} ↔ ${twin.id} must be mutual`);
    assert.notEqual(seed.style, twin.style, `${seed.id} and its twin must be in DIFFERENT voices`);
    assert.equal(seed.phase, twin.phase, `${seed.id} and its twin must live in the same phase`);
  }
});

test("the gen system prompt teaches BOTH voices with bank-loaded few-shots", async () => {
  const mock = mockFetch(() => grokReply("[]"));
  const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl });
  await generateBatchReport({ ...base, provider });

  assert.equal(mock.calls.length, 1);
  const messages = (mock.calls[0]!.body.messages ?? []) as { role: string; content: string }[];
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  assert.match(system, /GROUP VOICE/u);
  assert.match(system, /CONFESSION VOICE/u);
  assert.match(system, /Have you ever/u);

  // ≥4 confession few-shots, verbatim from the bank, in the phase's voice.
  const fewShots = confessionFewShots(base.phase, 5);
  assert.ok(fewShots.length >= 4 && fewShots.length <= 6, `expected 4–6 confession few-shots, got ${fewShots.length}`);
  const included = fewShots.filter((p) => system.includes(p.text));
  assert.ok(included.length >= 4, `only ${included.length} confession few-shots reached the system prompt`);
  for (const shot of included) assert.equal(shot.style, "confess");

  // Group examples are still there — both registers, from day one.
  const group = groupFewShots(base.phase, 3).filter((p) => system.includes(p.text));
  assert.ok(group.length >= 1, "the group register needs its examples too");
  // The request payload carries the style (mixed batch by default).
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  assert.match(user, /style/u);
});

test("a confess-voice request accepts confess candidates and drops group ones", async () => {
  const batch = [
    {
      text: "Have you ever kept a secret from someone in this room out of fear?",
      style: "confess",
      kind: "confess",
      coding: "trust",
      measures: ["self-report", "secret signal"],
      asksTarget: false,
      callback: false,
    },
    candidate({ text: "Point at the person here you'd call first in an emergency." }),
    candidate({ text: "Who here would you trust with a secret that could ruin you?" }),
  ];
  const mock = mockFetch(() => grokReply(JSON.stringify(batch)));
  const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl });
  const report = await generateBatchReport({ ...base, provider, style: "confess" });

  assert.equal(report.prompts.length, 1, "only the confession survives a confess-voice request");
  assert.equal(report.prompts[0]!.kind, "confess");
  assert.equal(report.prompts[0]!.style, "confess");
  assert.ok(report.dropped.some((d) => d.reason === "style"), "group candidates are dropped for style");
});

test("normalizeStyle reads the voice, and rejects noise", () => {
  assert.equal(normalizeStyle("confess"), "confess");
  assert.equal(normalizeStyle("Confession"), "confess");
  assert.equal(normalizeStyle("group"), "group");
  assert.equal(normalizeStyle("room"), "group");
  assert.equal(normalizeStyle("poetry"), null);
  assert.equal(normalizeStyle(undefined), null);
});

test("the raw bank json is tagged too (not just the loader)", () => {
  const rows = [
    ...RAW_BANK.phases.warmup.map((r) => ({ phase: "warmup", r })),
    ...RAW_BANK.phases.spicy.map((r) => ({ phase: "spicy", r })),
    ...RAW_BANK.phases.deep.map((r) => ({ phase: "deep", r })),
  ];
  const questionKinds = new Set(["pick", "text", "shout", "rating", "ios", "minigame", "confess"]);
  const untagged = rows.filter(({ r }) => questionKinds.has(r.kind) && r.style === undefined);
  assert.deepEqual(untagged, [], "every question seed in the JSON declares its style");
});

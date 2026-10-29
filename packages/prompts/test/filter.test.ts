// packages/prompts/test/filter.test.ts
// The guardrail is the only thing standing between Grok and a room of friends:
// schema, banned patterns, hard blocks, placeholders, dedupe, data-or-dead.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PROMPT_CHARS,
  MIN_PROMPT_CHARS,
  badPlaceholder,
  checkBanned,
  checkDataOrDead,
  checkHardBlocked,
  containsVerbatimQuote,
  filterCandidates,
  hasRoomReference,
  isRoomDirected,
  normalizeKind,
  normalizeMeasures,
  type FilterContext,
} from "../src/index.ts";
import { candidate } from "./helpers.ts";

const ctx = (over: Partial<FilterContext> = {}): FilterContext => ({
  phase: "spicy",
  playerCount: 6,
  usedIds: [],
  usedTexts: [],
  idPrefix: "grok",
  limit: 15,
  ...over,
});

const run = (raws: unknown[], over: Partial<FilterContext> = {}) => filterCandidates(raws, ctx(over));
const reasons = (raws: unknown[], over: Partial<FilterContext> = {}) => run(raws, over).dropped.map((d) => d.reason);

test("accepts a well-formed candidate and stamps the contract shape", () => {
  const { prompts, dropped } = run([candidate()]);
  assert.deepEqual(dropped, []);
  assert.equal(prompts.length, 1);
  const p = prompts[0]!;
  assert.equal(p.source, "grok");
  assert.equal(p.phase, "spicy");
  assert.equal(p.kind, "pick");
  assert.equal(p.coding, "trust");
  assert.deepEqual(p.measures, ["trust network"]);
  assert.equal(p.asksTarget, true);
  assert.match(p.id, /^grok-spicy-\d+$/);
});

test("drops a candidate whose measures are empty (random spectacle)", () => {
  assert.deepEqual(reasons([candidate({ measures: [] })]), ["measures"]);
  assert.deepEqual(reasons([candidate({ measures: ["", "  "] })]), ["measures"]);
  assert.deepEqual(reasons([candidate({ measures: undefined })]), ["measures"]);
});

test("drops a candidate that targets nobody in the room", () => {
  assert.deepEqual(
    reasons([candidate({ text: "Describe your morning routine in three excruciating details.", kind: "text", asksTarget: false })]),
    ["not-room-directed"],
  );
  // A dare with no target and no room reference measures nothing either.
  assert.deepEqual(
    reasons([candidate({ text: "Do a backflip right now and post the clip.", kind: "dare", asksTarget: false })], {
      phase: "dare",
    }),
    ["not-room-directed"],
  );
});

test("keeps room-directed text prompts that name the room", () => {
  const { prompts } = run([
    candidate({
      text: "What did someone in this room tell you that you still think about?",
      kind: "text",
      asksTarget: false,
      coding: "trust",
    }),
  ]);
  assert.equal(prompts.length, 1);
});

test("drops every banned pattern from spec §6", () => {
  const banned = [
    "Who here is your favourite person and why exactly?",
    "Who in this room survives a zombie outbreak the longest? Point.",
    "Who here would you take to a desert island, and why them?",
    "Who here is most likely to get arrested tonight? Point.",
    "Two truths and a lie about someone in this room — go.",
    "Would you rather date someone here or never speak again?",
    "What is your fun fact for this group tonight then?",
  ];
  for (const text of banned) {
    const verdict = checkBanned(text);
    assert.ok(verdict, `not caught: ${text}`);
    assert.deepEqual(reasons([candidate({ text, kind: "pick" })]), ["banned"], text);
  }
});

test("hard blocks stay hard: minors, non-consent, explicit acts, real people", () => {
  const blocked = [
    "Who here would hook up with a schoolgirl from the group's story?",
    "Describe the last time you got someone drugged and regret nothing.",
    "Who here would film a sex tape with someone in this room?",
    "Which celebrity would you sleep with, and why them? Point.",
  ];
  for (const text of blocked) {
    assert.ok(checkHardBlocked(text), `not blocked: ${text}`);
  }
});

test("length window is 20–160 characters", () => {
  const short = candidate({ text: "Point at someone." });
  const long = candidate({ text: `Who here ${"really ".repeat(30)}matters to you?` });
  assert.deepEqual(reasons([short]), ["too-short"]);
  assert.deepEqual(reasons([long]), ["too-long"]);
  assert.ok(MIN_PROMPT_CHARS === 20 && MAX_PROMPT_CHARS === 160);
  // Exactly at the boundaries survives.
  const min = candidate({ text: "Who here is the most chaotic? Point now." });
  assert.ok(String(min.text).length >= 20);
  assert.equal(run([min]).prompts.length, 1);
});

test("placeholders: only {P1}..{P11}, never invented tokens, never above the roster", () => {
  assert.equal(badPlaceholder("Rate {P2}'s rizz 1–10, be honest about it."), null);
  assert.equal(badPlaceholder("Rate {P12}'s rizz, honestly now please."), "{P12}");
  assert.equal(badPlaceholder("Rate {P0}'s rizz, honestly now please."), "{P0}");
  assert.equal(badPlaceholder("Rate {player}'s rizz, honestly now."), "{player}");
  assert.deepEqual(reasons([candidate({ text: "Rate {P12}'s chaos, 1–10, no lying.", kind: "rating" })]), ["bad-placeholder"]);
  assert.deepEqual(
    reasons([candidate({ text: "Rate {P9}'s chaos, 1–10, no lying at all.", kind: "rating", measures: ["trait:chaos"] })]),
    ["player-count"],
  );
});

test("phase and kind are validated against the phase's own menu", () => {
  assert.deepEqual(reasons([candidate({ phase: "deep" })]), ["phase"]);
  assert.deepEqual(reasons([candidate({ kind: "dare" })]), ["kind"]);
  assert.deepEqual(reasons([candidate({ kind: "telepathy" })]), ["kind"]);
  assert.deepEqual(reasons([candidate({ coding: "vibes" })]), ["coding"]);
  const dareOk = run([candidate({ kind: "dare", text: "Let {P1} read your last DM to them out loud.", coding: "trust" })], {
    phase: "dare",
  });
  assert.equal(dareOk.prompts.length, 1);
});

test("kind and coding aliases normalise instead of dropping good candidates", () => {
  assert.equal(normalizeKind("poll"), "pick");
  assert.equal(normalizeKind("pair-dare"), "pair_dare");
  assert.equal(normalizeKind("question"), "text");
  const { prompts } = run([candidate({ kind: "poll", coding: "friends" })]);
  assert.equal(prompts[0]!.kind, "pick");
  assert.equal(prompts[0]!.coding, "friendship");
});

test("measures accept a string and split it deterministically", () => {
  assert.deepEqual(normalizeMeasures("trust; affection"), ["trust", "affection"]);
  assert.deepEqual(normalizeMeasures(["  ", "trust"]), ["trust"]);
  const { prompts } = run([candidate({ measures: "trust network, mutual picks" })]);
  assert.deepEqual(prompts[0]!.measures, ["trust network", "mutual picks"]);
});

test("dedupe against the bank, against usedIds and within the batch", () => {
  const bankText = "Who here would survive the longest in a horror movie? Point at them.";
  assert.deepEqual(reasons([candidate({ text: bankText })], { usedTexts: [bankText] }), ["duplicate"]);
  assert.deepEqual(reasons([candidate({}, )], { usedIds: ["grok-spicy-1"] }).length, 0);
  const { prompts } = run([candidate()], { usedIds: ["grok-spicy-1"] });
  assert.notEqual(prompts[0]!.id, "grok-spicy-1");

  const nearA = candidate({ text: "Who here would you trust to lie for you without asking a single question?" });
  const nearB = candidate({ text: "Who here would you trust to lie for you without asking one single question?" });
  const result = run([nearA, nearB]);
  assert.equal(result.prompts.length, 1);
  assert.deepEqual(result.dropped.map((d) => d.reason), ["duplicate"]);
});

test("asksTarget is derived for pick/ios when the model omits it", () => {
  const { prompts } = run([candidate({ asksTarget: undefined })]);
  assert.equal(prompts[0]!.asksTarget, true);
  const text = run([candidate({ kind: "text", text: "Who here owes you an apology they never gave?", asksTarget: undefined })]);
  assert.equal(text.prompts[0]!.asksTarget, false);
});

test("limit is honoured and the remainder is reported, never silently dropped", () => {
  const raws = [
    candidate({ text: "Who here would you call first after the worst day of the year?" }),
    candidate({ text: "Who here would you let pick your next tattoo, no veto at all?" }),
    candidate({ text: "Who here would you sit beside on a nine-hour bus ride?" }),
  ];
  const { prompts, dropped } = run(raws, { limit: 2 });
  assert.equal(prompts.length, 2);
  assert.equal(dropped.length, 1);
});

test("isRoomDirected: directed kinds count, undirected prose does not", () => {
  assert.equal(isRoomDirected({ kind: "pick", text: "Point at the loudest one." }), true);
  assert.equal(isRoomDirected({ kind: "ios", text: "How close are you two?" }), true);
  assert.equal(isRoomDirected({ kind: "shout", text: "One word for this night." }), true);
  assert.equal(isRoomDirected({ kind: "text", text: "What is your earliest memory?" }), false);
  assert.equal(isRoomDirected({ kind: "text", text: "Who here knows your worst secret?" }), true);
  assert.equal(hasRoomReference("Rate {P3}'s chaos, 1–10."), true);
  assert.equal(hasRoomReference("A quiet morning alone."), false);
});

test("checkDataOrDead rejects on each leg independently", () => {
  assert.equal(checkDataOrDead({ kind: "pick", text: "Who here is the best cook? Point.", coding: "neutral", measures: [] }).reason, "measures");
  assert.equal(
    checkDataOrDead({ kind: "text", text: "Describe your commute in detail.", coding: "neutral", measures: ["tags"] }).reason,
    "not-room-directed",
  );
  assert.equal(
    checkDataOrDead({ kind: "pick", text: "Who here is the best cook? Point.", coding: "vibes" as never, measures: ["trust"] }).reason,
    "coding",
  );
  assert.equal(checkDataOrDead({ kind: "pick", text: "Who here is the best cook? Point.", coding: "neutral", measures: ["trust network"] }).ok, true);
});

test("containsVerbatimQuote only matches real, long-enough quotes", () => {
  const text = 'Who said "I once drove to Mombasa to avoid a group chat" and why?';
  assert.equal(containsVerbatimQuote(text, "I once drove to Mombasa to avoid a group chat"), true);
  assert.equal(containsVerbatimQuote(text, "I once drove to Kisumu"), false);
  assert.equal(containsVerbatimQuote(text, "short"), false);
});

test("never throws on hostile model output", () => {
  const junk = [null, undefined, 42, "string", [], {}, { text: {} }, { text: null, kind: "pick" }];
  for (const raw of junk) {
    const { prompts, dropped } = run([raw]);
    assert.equal(prompts.length, 0);
    assert.equal(dropped.length, 1);
  }
});

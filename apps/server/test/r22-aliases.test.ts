import assert from "node:assert/strict";
import { test } from "node:test";
import { containsAlias, redactAliases } from "../../../packages/prompts/src/provider.ts";
import { derivePseudonyms, scrubAliases, swapPseudonyms } from "../../../packages/narrator/src/roster.ts";
import type { NightDigest, Results } from "../../../packages/shared/src/contracts.ts";
import { pseudonymizeText, restoreAliases } from "../src/pseudonyms.ts";
import { ALIAS_REPLACE_MIN } from "../../../lib/aliases.ts";

const players = [{ id: "p1", alias: "Ali" }, { id: "p2", alias: "Mo" }, { id: "p3", alias: "May" }];
const digest: NightDigest = { quotes: [], stats: {}, runningGags: [], pickTeasers: [], dodges: [], selfVsRoom: [] };
// v3.2 Results has no `claims` — the verdict list is what the roster is derived
// from, and this test passes an explicit roster, so the shape change is all it needs.
const results: Results = { roomId: "r22", verdicts: [], pairScores: [], computedAt: 1000 };

test("R22: alias replacement uses whole words, skips short names, and is idempotent", () => {
  assert.equal(ALIAS_REPLACE_MIN, 3);
  const source = "Ali is alive. Mo is here. May I ask may?";
  const expected = "Player 1 is alive. Mo is here. Player 3 I ask Player 3?";
  assert.equal(pseudonymizeText(source, players), expected);
  assert.equal(pseudonymizeText(expected, players), expected, "a second redaction must not recode its output");
  assert.equal(pseudonymizeText("ALI May-alive alive_May", players), "Player 1 Player 3-alive alive_May");
  const restored = restoreAliases("Player 1 and Player 3", players);
  assert.equal(restored, "Ali and May");
  assert.equal(restoreAliases(restored, players), restored);
});

test("R22: escaped metacharacters and overlapping names cannot cause cascading replacements", () => {
  const roster = [{ id: "p1", alias: "A.B" }, { id: "p2", alias: "ABC" }, { id: "p3", alias: "May" }, { id: "p4", alias: "Maya" }];
  const once = pseudonymizeText("A.B AXB ABC Maya May", roster);
  assert.equal(once, "Player 1 AXB Player 2 Player 4 Player 3");
  assert.equal(pseudonymizeText(once, roster), once);
  const dollars = [{ id: "p1", alias: "Cash$" }];
  assert.equal(restoreAliases("Player 1", dollars), "Cash$");
  assert.equal(pseudonymizeText("Cash$", dollars), "Player 1");
});

test("R22: the provider safety net has the same minimum and boundary policy", () => {
  const aliases = players.map((player) => player.alias);
  assert.equal(redactAliases("Ali is alive; Mo; May I ask", aliases), "someone in the room is alive; Mo; someone in the room I ask");
  assert.equal(containsAlias("alive model", aliases), false);
  assert.equal(containsAlias("May", aliases), true);
  assert.equal(containsAlias("Mo", aliases), false, "short aliases are deliberately outside replacement policy");
  const once = redactAliases("May and Maya", ["May", "Maya"]);
  assert.equal(redactAliases(once, ["May", "Maya"]), once);
});

test("R22: narrator scrub and recode are whole-word, minimum-length, and single-pass", () => {
  const roster = [{ id: "p1", alias: "Ali" }, { id: "p2", alias: "Mo" }, { id: "p3", alias: "May" }];
  const ps = derivePseudonyms(results, digest, roster);
  const once = scrubAliases("Ali is alive; Mo; May I ask", ps, roster);
  assert.equal(once, "Player 1 is alive; Mo; Player 3 I ask");
  assert.equal(scrubAliases(once, ps, roster), once);
  // A real alias can contain replacement metacharacters. Recoding must treat
  // it as text, not as a replacement template or as another Player N token.
  const special = [{ id: "p1", alias: "$& May" }, { id: "p2", alias: "May" }];
  assert.equal(swapPseudonyms("Player 1 met Player 2", special), "$& May met May");
  assert.equal(swapPseudonyms("$& May met May", special), "$& May met May");
});

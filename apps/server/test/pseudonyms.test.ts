import assert from "node:assert/strict";
import { test } from "node:test";
import { pseudonymizeText, restoreAliases } from "../src/pseudonyms.ts";

test("pseudonym substitution respects Unicode word boundaries and protects contained aliases", () => {
  const players = [{ id: "p1", alias: "Ian" }, { id: "p2", alias: "An" }, { id: "p3", alias: "Brian" }];
  assert.equal(pseudonymizeText("Ian told Brian; An agreed.", players), "Player 1 told Player 3; Player 2 agreed.");
  assert.equal(pseudonymizeText("Brianian and candy", players), "Brianian and candy");
  assert.equal(pseudonymizeText("Zoe\u0308 said hello", [{ id: "p4", alias: "Zoë" }]), "Player 1 said hello", "NFD alias spellings cannot evade provider redaction");
});

test("swap-back uses deterministic room order and whole pseudonym tokens", () => {
  const players = [{ id: "p1", alias: "Ian" }, { id: "p2", alias: "An" }];
  assert.equal(restoreAliases("Player 1 met Player 2; Player 10 remains.", players), "Ian met An; Player 10 remains.");
});

test("an alias shaped like a pseudonym cannot hijack another player's token", () => {
  // "Player 3" is a legal gamertag (2–14 chars). Substituting aliases one at a
  // time let it match the token Samantha's alias had just written, so a mention
  // of Samantha restored as "Player 3" — a different guest — in public copy.
  const players = [
    { id: "p1", alias: "Ada" }, { id: "p2", alias: "Ben" },
    { id: "p3", alias: "Samantha" }, { id: "p4", alias: "Player 3" },
  ];
  const once = pseudonymizeText("Samantha waved at Player 3.", players);
  assert.equal(once, "Player 3 waved at Player 4.");
  assert.equal(restoreAliases(once, players), "Samantha waved at Player 3.");
});

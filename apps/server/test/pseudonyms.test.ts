import assert from "node:assert/strict";
import { test } from "node:test";
import { pseudonymizeText, restoreAliases } from "../src/pseudonyms.ts";

test("pseudonym substitution respects Unicode word boundaries and protects contained aliases", () => {
  const players = [{ id: "p1", alias: "Ian" }, { id: "p2", alias: "An" }, { id: "p3", alias: "Brian" }];
  assert.equal(pseudonymizeText("Ian told Brian; An agreed.", players), "Player 1 told Player 3; Player 2 agreed.");
  assert.equal(pseudonymizeText("Brianian and candy", players), "Brianian and candy");
});

test("swap-back uses deterministic room order and whole pseudonym tokens", () => {
  const players = [{ id: "p1", alias: "Ian" }, { id: "p2", alias: "An" }];
  assert.equal(restoreAliases("Player 1 met Player 2; Player 10 remains.", players), "Ian met An; Player 10 remains.");
});

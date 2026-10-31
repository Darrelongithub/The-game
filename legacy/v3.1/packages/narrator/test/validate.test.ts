// test/validate.test.ts — the gate. Nothing reaches a phone unless it passes.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BANNED_PHRASES,
  digitsIn,
  findIllegalNumber,
  findIllegalPlayerReference,
  LIMITS,
  looksLikeRefusal,
  playerTokensIn,
  validateBody,
  validateCardTitle,
  validateFact,
  validateTitle,
} from "../src/validate.ts";


describe("numbers", () => {
  it("accepts digits that exist in the claim's numbers", () => {
    const limits = { numbers: new Set(["6", "8", "0.75"]) };
    assert.equal(validateBody("6 of 8 picks agreed.", limits).ok, true);
  });

  it("rejects an invented number", () => {
    const result = validateBody("7 of 8 picks agreed.", { numbers: new Set(["6", "8"]) });
    assert.deepEqual(result, { ok: false, reason: "invented-number:7" });
  });

  it("rejects a rounded percentage that was never computed for it", () => {
    const result = validateBody("75% of the room agreed.", { numbers: new Set(["6", "8", "0.75"]) });
    assert.equal(result.ok, false);
  });

  it("does not treat the Player N label as a number", () => {
    const limits = { numbers: new Set<string>(), players: new Set(["Player 3"]) };
    assert.equal(validateBody("Player 3 did this.", limits).ok, true);
    assert.deepEqual(digitsIn(["Player 3 did this."]), new Set<string>());
  });

  it("rejects every digit when the claim has no numbers", () => {
    assert.equal(findIllegalNumber("They did it 3 times", new Set<string>()), "3");
    assert.equal(findIllegalNumber("No digits here", new Set<string>()), undefined);
  });

  it("rejects a decimal that is not written for it", () => {
    const result = validateBody("The score was 0.85.", { numbers: new Set(["0.89"]) });
    assert.equal(result.ok, false);
  });
});

describe("player references", () => {
  const maxPlayer = 7;

  it("accepts Player N in range and on-slide", () => {
    const limits = { players: new Set(["Player 2", "Player 5"]), maxPlayer };
    assert.equal(validateBody("Player 2 and Player 5 did this.", limits).ok, true);
  });

  it("rejects a player the engine never put on this slide", () => {
    const limits = { players: new Set(["Player 2", "Player 5"]), maxPlayer };
    assert.deepEqual(validateBody("Player 4 did this.", limits), {
      ok: false,
      reason: "bad-player-ref:Player 4",
    });
  });

  it("rejects a player outside the roster", () => {
    assert.equal(
      findIllegalPlayerReference("Player 9 said it", new Set(["Player 9"]), maxPlayer),
      "Player 9",
    );
  });

  it("rejects spelled-out player names", () => {
    assert.equal(findIllegalPlayerReference("Player One said it", undefined, maxPlayer), "Player One");
    assert.equal(findIllegalPlayerReference("Player Eric said it", undefined, maxPlayer), "Player Eric");
  });

  it("rejects any player reference on a slide with no players", () => {
    assert.equal(
      validateBody("Player 3 has thoughts.", { players: new Set(), maxPlayer }).ok,
      false,
    );
  });

  it("does not flag the plural word players", () => {
    const result = validateBody("All players agree.", { players: new Set(), maxPlayer });
    assert.equal(result.ok, true);
  });

  it("collects canonical tokens", () => {
    assert.deepEqual(playerTokensIn(["player 3 and PLAYER 10"]), new Set(["Player 3", "Player 10"]));
  });
});

describe("banned phrases", () => {
  const limits = {};

  it("rejects every required phrase on a slide body", () => {
    for (const phrase of BANNED_PHRASES) {
      const result = validateBody(`Honestly this is pure ${phrase} energy.`, limits);
      assert.equal(result.ok, false, `expected "${phrase}" to be rejected`);
    }
  });

  it("rejects every required phrase on a secret-card fact", () => {
    for (const phrase of BANNED_PHRASES) {
      const result = validateFact(`Your card says: ${phrase}.`, limits);
      assert.equal(result.ok, false, `expected "${phrase}" to be rejected from a fact`);
    }
  });

  it("is case insensitive and matches inflections", () => {
    assert.equal(validateBody("Pure RED FLAG behaviour.", limits).ok, false);
    assert.equal(validateBody("A total narcissist about the aux cable.", limits).ok, false);
    assert.equal(validateBody("This is basically a diagnosis.", limits).ok, false);
  });

  it("allows warm copy", () => {
    assert.equal(
      validateBody("You two have been running this room since round one.", limits).ok,
      true,
    );
  });
});

describe("length, emptiness and refusals", () => {
  it("enforces body <= 140", () => {
    const ok = validateBody("a".repeat(LIMITS.bodyMaxChars), {});
    const bad = validateBody("a".repeat(LIMITS.bodyMaxChars + 1), {});
    assert.equal(ok.ok, true);
    assert.deepEqual(bad, { ok: false, reason: "too-long" });
  });

  it("enforces fact <= 120", () => {
    assert.equal(validateFact("a".repeat(LIMITS.factMaxChars), {}).ok, true);
    assert.deepEqual(validateFact("a".repeat(LIMITS.factMaxChars + 1), {}), {
      ok: false,
      reason: "too-long",
    });
  });

  it("enforces title <= 6 words", () => {
    assert.equal(validateTitle("SIX WORDS IS THE LIMIT HERE", {}).ok, true);
    assert.deepEqual(validateTitle("SEVEN WORDS IS ONE TOO MANY HERE", {}), {
      ok: false,
      reason: "too-many-words",
    });
  });

  it("enforces card title length", () => {
    assert.equal(validateCardTitle("SPARK", {}).ok, true);
    assert.equal(validateCardTitle("x".repeat(LIMITS.cardTitleMaxChars + 1), {}).ok, false);
  });

  it("never accepts empty or whitespace text", () => {
    assert.deepEqual(validateBody("", {}), { ok: false, reason: "empty" });
    assert.deepEqual(validateBody("   ", {}), { ok: false, reason: "empty" });
    assert.deepEqual(validateBody(undefined, {}), { ok: false, reason: "not-a-string" });
  });

  it("rejects provider refusals masquerading as copy", () => {
    assert.equal(looksLikeRefusal("As an AI, I cannot comment on that."), true);
    assert.equal(validateBody("I'm sorry, but I can't help with that.", {}).ok, false);
    assert.equal(validateBody("This room is unhinged in the best way.", {}).ok, true);
  });

  it("rejects control characters", () => {
    assert.equal(validateBody("bad\u0007copy", {}).ok, false);
  });
});

describe("real aliases", () => {
  it("rejects a real alias in narration copy", () => {
    const limits = { aliases: ["Maya", "Zed"] };
    assert.deepEqual(validateBody("Maya said it best.", limits), {
      ok: false,
      reason: "real-alias:Maya",
    });
  });

  it("does not flag an alias inside another word", () => {
    const limits = { aliases: ["Zed"] };
    assert.equal(validateBody("The zedonk escaped.", limits).ok, true);
  });
});

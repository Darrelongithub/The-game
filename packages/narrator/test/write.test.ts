import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSkeleton } from "../src/slides.ts";
import { writeFinale } from "../src/write.ts";
import { night, ROSTER } from "./fixtures.ts";

test("finale narration is template-only and never calls Gemini, even with a key", async () => {
  const fresh = night();
  const skeleton = buildSkeleton(fresh.results, fresh.digest, ROSTER);
  let requests = 0;
  const result = await writeFinale(skeleton, fresh.decks, fresh.results, fresh.digest, {
    apiKey: "configured-but-analysis-only",
    env: { GEMINI_API_KEY: "configured-but-analysis-only", GEMINI_MODEL: "test-model" },
    fetchImpl: (async () => { requests++; throw new Error("Gemini reveal must not be called"); }) as typeof fetch,
    roster: ROSTER,
  });
  assert.equal(requests, 0);
  assert.deepEqual(result.slides, skeleton);
  assert.deepEqual([...result.decks], [...fresh.decks]);
});

test("optional Grok reveal lane receives pseudonymized structured input and safely falls back", async () => {
  const fresh = night();
  const skeleton = buildSkeleton(fresh.results, fresh.digest, ROSTER);
  let payload: Record<string, unknown> | undefined;
  const result = await writeFinale(skeleton, fresh.decks, fresh.results, fresh.digest, {
    roster: ROSTER,
    grok: async input => { payload = input; return { slides: [], secretCards: [] }; },
  });
  assert.ok(payload);
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes("Maya") && !serialized.includes("Wanjiru"), "real aliases never leave the server");
  assert.ok(Array.isArray(payload["slides"]));
  assert.ok(Array.isArray(payload["secretCards"]));
  assert.deepEqual(result.slides, skeleton, "empty or unusable Grok output preserves engine copy");
  assert.deepEqual(result.decks, fresh.decks, "private decks remain separate in the return shape");
});

test("template finale output is deterministic and preserves private decks separately", async () => {
  const fresh = night();
  const skeleton = buildSkeleton(fresh.results, fresh.digest, ROSTER);
  const a = await writeFinale(skeleton, fresh.decks, fresh.results, fresh.digest, { roster: ROSTER });
  const b = await writeFinale(skeleton, fresh.decks, fresh.results, fresh.digest, { roster: ROSTER });
  assert.deepEqual(a, b);
  assert.deepEqual(a.decks, fresh.decks);
  assert.ok(a.slides.every(slide => !JSON.stringify(slide).includes("spark")));
});

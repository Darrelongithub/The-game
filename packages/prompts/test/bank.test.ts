// packages/prompts/test/bank.test.ts
// The prompt bank.
//
// The rules under test:
//   • ≥150 prompts, wildly varied.
//   • The unhinged tier loads BEFORE the seed prompts.
//   • The seeded shuffle is reproducible and different across nights.
//   • A template is never used twice in one night.
//   • No prompt targets nobody: every question is about someone in the room.
//   • The three generic prompts are gone.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BANK,
  BANK_BANDS,
  loadBank,
  metricOf,
  selectFromBank,
  seededShuffle,
  bankCounts,
} from "../src/index.ts";
import { RAW_BANK } from "../src/bank/index.ts";
import { CASES_PER_NIGHT } from "../../shared/src/contracts.ts";

const GENERIC = [
  /which vibe are you looking for/i,
  /point at that person/i,
  /how warm are you,?\s*honestly/i,
];

describe("the bank", () => {
  it("has at least 150 prompts", () => {
    assert.ok(BANK.length >= 150, `bank has ${BANK.length} prompts, needs 150+`);
  });

  it("has prompts in every band", () => {
    const counts = bankCounts();
    for (const band of BANK_BANDS) {
      assert.ok(counts[band] > 0, `band ${band} is empty`);
    }
  });

  it("carries the spicy/unhinged tier BEFORE the seed prompts", () => {
    const firstUnhinged = BANK.findIndex((p) => p.id.startsWith("un-"));
    const firstSpicySeed = BANK.findIndex((p) => p.id.startsWith("sp-"));
    assert.ok(firstUnhinged >= 0, "the unhinged tier must be in the bank");
    assert.ok(firstUnhinged < firstSpicySeed, "the unhinged tier must load before the seeds");
  });

  it("has 10+ spicy warm-ups so the night starts hot", () => {
    const warmups = RAW_BANK.bands.warmup;
    const spicyWarmups = warmups.filter((w) =>
      /sex|sleep with|kiss|body count|best in bed|cheat|snitch|ghost|hookup|dating app|swipe/i.test(w.text),
    );
    assert.ok(spicyWarmups.length >= 10, `only ${spicyWarmups.length} spicy warm-ups`);
  });

  it("never carries the same template twice", () => {
    const seen = new Map<string, string>();
    for (const prompt of BANK) {
      const key = prompt.text.trim().toLowerCase();
      const previous = seen.get(key);
      assert.ok(!previous, `prompt ${prompt.id} repeats the template of ${previous}`);
      seen.set(key, prompt.id);
    }
  });

  it("contains none of the three deleted generic prompts", () => {
    for (const p of BANK) {
      for (const pattern of GENERIC) {
        assert.doesNotMatch(p.text, pattern, `prompt ${p.id} still has a generic prompt`);
      }
    }
  });

  it("gives every prompt a role, a kind and at least one measure", () => {
    for (const p of BANK) {
      assert.ok(p.role, `prompt ${p.id} has no role`);
      assert.ok(p.kind, `prompt ${p.id} has no kind`);
      assert.ok(p.measures.length > 0, `prompt ${p.id} measures nothing`);
      assert.equal(p.source, "bank");
    }
  });

  it("has prompts for every role the case engine needs", () => {
    const roles = new Set(BANK.map((p) => p.role));
    for (const role of ["subject", "observer_subject", "observer_pair", "group", "solo", "dare"]) {
      assert.ok(roles.has(role as never), `no prompts for role ${role}`);
    }
  });

  it("has enough prompts for the biggest possible room", () => {
    // 11 players → 5 observer pairs per case, ~12 cases. Every case needs a
    // subject prompt and one prompt per pair.
    const observer = BANK.filter((p) => p.role === "observer_subject" || p.role === "observer_pair");
    assert.ok(observer.length >= 60, `only ${observer.length} observer prompts for a big room`);
    const subjects = BANK.filter((p) => p.role === "subject");
    assert.ok(subjects.length >= 12, `only ${subjects.length} subject prompts`);
    const solos = BANK.filter((p) => p.role === "solo");
    assert.ok(solos.length >= 6, `only ${solos.length} solo prompts`);
  });

  it("has a solo prompt for every case of a night", () => {
    // When the observer count is odd, the leftover answers a solo spicy
    // prompt. That happens in EVERY case of a 4-, 6-, 8- or 10-player room,
    // so the solo supply has to cover a whole night.
    const solos = BANK.filter((p) => p.role === "solo").length;
    assert.ok(solos >= CASES_PER_NIGHT, `only ${solos} solo prompts for a night of ${CASES_PER_NIGHT} cases`);
  });

  it("never asks a question about nobody", () => {
    for (const p of BANK) {
      const aboutTheRoom = /\{P\d+\}|\bthis room\b|\bthe room\b|\byou\b|\byour\b|\byourself\b|\beveryone\b|\bsomeone\b|\banyone\b|\bthe group\b|\bhere\b|\bpeople\b|\bthis party\b/i.test(p.text);
      assert.ok(aboutTheRoom, `prompt ${p.id} targets nobody: ${p.text}`);
    }
  });

  it("keeps every placeholder index inside the room size", () => {
    for (const p of BANK) {
      const indexes = [...p.text.matchAll(/\{P(\d{1,2})\}/g)].map((m) => Number(m[1]));
      for (const index of indexes) {
        assert.ok(index >= 1 && index <= 11, `prompt ${p.id} uses {P${index}}`);
      }
    }
  });

  it("gives the dare band only dares", () => {
    for (const p of BANK.filter((x) => x.band === "dare")) {
      assert.equal(p.kind, "dare");
      assert.equal(p.role, "dare");
    }
  });

  it("carries metrics the engine can key off", () => {
    const metrics = new Set(BANK.map((p) => metricOf(p)).filter(Boolean));
    for (const key of ["sex-desire", "crush", "body-count", "best-in-bed", "would-cheat", "would-snitch", "is-fake", "couple-fit"]) {
      assert.ok(metrics.has(key as never), `no prompt measures ${key}`);
    }
  });
});

describe("the seeded shuffle", () => {
  it("is reproducible for a given seed", () => {
    const a = seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], 42);
    const b = seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], 42);
    assert.deepEqual(a, b);
  });

  it("gives a different order for a different seed", () => {
    const a = seededShuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 1);
    const b = seededShuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 2);
    assert.notDeepEqual(a, b);
  });

  it("changes the night's selection between nights", () => {
    const nightOne = selectFromBank(10, { seed: 111 }).map((p) => p.id);
    const nightTwo = selectFromBank(10, { seed: 222 }).map((p) => p.id);
    assert.notDeepEqual(nightOne, nightTwo);
  });

  it("never repeats a template when excluded ids are passed in", () => {
    const first = selectFromBank(5, { seed: 7 });
    const second = selectFromBank(5, { seed: 7, excludeIds: first.map((p) => p.id) });
    const overlap = second.filter((p) => first.some((q) => q.id === p.id));
    assert.equal(overlap.length, 0, "a template repeated inside one night");
  });

  it("never returns two prompts of the same kind back to back", () => {
    const picks = selectFromBank(12, { seed: 99 });
    for (let i = 1; i < picks.length; i++) {
      const sameKind = picks[i]!.kind === picks[i - 1]!.kind;
      const sameMetric = metricOf(picks[i]!) === metricOf(picks[i - 1]!);
      assert.ok(!(sameKind && sameMetric), `two ${picks[i]!.kind} prompts landed back to back`);
    }
  });

  it("draws only the requested role", () => {
    const picks = selectFromBank(4, { role: "dare" });
    for (const p of picks) assert.equal(p.role, "dare");
  });

  it("draws only the requested metric", () => {
    const picks = selectFromBank(4, { metric: "sex-desire" });
    for (const p of picks) assert.equal(metricOf(p), "sex-desire");
  });

  it("skips prompts whose placeholders do not fit the room", () => {
    const picks = selectFromBank(20, { playerCount: 2 });
    for (const p of picks) {
      const indexes = [...p.text.matchAll(/\{P(\d{1,2})\}/g)].map((m) => Number(m[1]));
      for (const index of indexes) assert.ok(index <= 2, `prompt ${p.id} needs ${index} players`);
    }
  });
});

describe("loadBank", () => {
  it("can turn the unhinged tier off", () => {
    const tamed = loadBank({ spicy: false });
    assert.equal(tamed.filter((p) => p.id.startsWith("un-")).length, 0);
    assert.ok(tamed.length > 100);
  });
});

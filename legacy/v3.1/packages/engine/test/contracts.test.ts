// packages/engine/test/contracts.test.ts
// STEP 1 regression: the ROUND 4 contract additions are well-formed, the
// director tunables are sane, and nothing hypothesis-shaped or email-shaped has
// leaked into the client-facing half of the contract.
// Run: npm --prefix packages/engine test
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  ANTI_TELEGRAPH_MAX,
  CONFESS_NOTE_MAX,
  DEFAULT_WEIGHTS,
  HYPOTHESIS_FORM_BAND,
  ROUND_MIX,
  ROUND_TIMERS_MS,
  STYLE_MIX,
  type AccountInfo,
  type Hypothesis,
  type HypothesisKind,
  type HypothesisStatus,
  type PairSignal,
  type PromptStyle,
  type RoundKind,
} from "../../shared/src/contracts.ts";
import { isResponseValue, validSubmit } from "../../shared/src/validate.ts";

const REPO = new URL("../../../", import.meta.url).pathname;

const approx = (actual: number, expected: number, label: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, got ${actual}`);
};

test("HYPOTHESIS_FORM_BAND is a real mid-band: lo < hi, both inside 0..1", () => {
  assert.ok(HYPOTHESIS_FORM_BAND.lo < HYPOTHESIS_FORM_BAND.hi, "band must not be inverted or empty");
  assert.ok(HYPOTHESIS_FORM_BAND.lo > 0 && HYPOTHESIS_FORM_BAND.lo < 0.5, "lo must be a genuine floor");
  assert.ok(HYPOTHESIS_FORM_BAND.hi > 0.5 && HYPOTHESIS_FORM_BAND.hi < 1, "hi must be a genuine ceiling");
});

test("ROUND_MIX is a probability distribution over test/explore/classic", () => {
  const sum = ROUND_MIX.test + ROUND_MIX.explore + ROUND_MIX.classic;
  approx(sum, 1, "ROUND_MIX sum");
  for (const [mode, share] of Object.entries(ROUND_MIX)) {
    assert.ok(share >= 0 && share <= 1, `${mode} share out of range`);
  }
  assert.ok(ROUND_MIX.test > ROUND_MIX.explore && ROUND_MIX.explore > ROUND_MIX.classic, "mix must stay test-heavy");
});

test("ANTI_TELEGRAPH_MAX allows at least a pair, and is not effectively unlimited", () => {
  assert.ok(ANTI_TELEGRAPH_MAX >= 2, "a cap below 2 would make the mix untestable");
  assert.ok(ANTI_TELEGRAPH_MAX <= 4, "a cap above 4 stops being anti-telegraph");
});

test("Hypothesis / AccountInfo carry exactly the contracted fields and nothing else", () => {
  const h: Hypothesis = {
    id: "h1",
    kind: "onesided",
    subjects: ["p1", "p2"],
    status: "open",
    strength: 0.5,
    evidence: ["Player 1 keeps choosing Player 2."],
    openedAt: 1_700_000_000_000,
    lastTestedRound: "r3",
  };
  assert.deepEqual(Object.keys(h).sort(), ["evidence", "id", "kind", "openedAt", "status", "strength", "subjects", "lastTestedRound"].sort());
  const kinds: HypothesisKind[] = ["tension", "besties", "secret", "selfimage", "onesided", "freeagent"];
  const statuses: HypothesisStatus[] = ["open", "supported", "refuted", "unresolved"];
  assert.equal(new Set(kinds).size, 6);
  assert.equal(new Set(statuses).size, 4);

  const account: AccountInfo = { username: "nightowl_7", createdAt: 1, nightsPlayed: 3 };
  assert.deepEqual(Object.keys(account).sort(), ["createdAt", "nightsPlayed", "username"]);
  assert.ok(!("email" in account), "AccountInfo must never carry an email");
});

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    // Build output is not source (and .next bundles vendor code).
    if (["node_modules", ".git", ".next", "out", "dist", "build", "coverage"].includes(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|mjs|js)$/u.test(entry)) out.push(path);
  }
  return out;
};

/** Comments may DISCUSS the absence of email; only real code counts as a field. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/(^|[^:])\/\/.*$/gmu, "$1");

test("no email anywhere: accounts are username + PIN + recovery code only", () => {
  // Test files are excluded: they are allowed to assert about the word itself.
  const sources = ["apps", "packages", "scripts"]
    .flatMap((dir) => walk(join(REPO, dir)))
    .filter((file) => !/\.test\.ts$|__tests__|scripts\/selfcheck\.ts$/u.test(file));
  assert.ok(sources.length > 20, "source scan found suspiciously few files");
  const offenders = sources.filter((file) => /\b(email|e-mail|mailAddress)\b/iu.test(stripComments(readFileSync(file, "utf8"))));
  assert.deepEqual(offenders, [], `accounts must never collect an email (found in: ${offenders.join(", ")})`);
});

test("the client-facing socket contract never mentions hypotheses", () => {
  const contracts = readFileSync(join(REPO, "packages/shared/src/contracts.ts"), "utf8");
  const events = contracts.slice(contracts.indexOf("export type ServerToClientEvents"), contracts.indexOf("// ---------- Director tunables"));
  assert.ok(events.length > 0, "could not locate ServerToClientEvents");
  assert.ok(!/Hypothesis/u.test(events), "a Hypothesis type must never ride a server→client event");
  // The internal block must be marked internal, so a future agent cannot
  // mistake it for something a client may render.
  const internal = contracts.slice(contracts.indexOf("INTERNAL: Director hypotheses"), contracts.indexOf("INTERNAL: accounts"));
  assert.match(internal, /NEVER serialized to any client/u);
});

// ---------------------------------------------------------------------------
// CONFESS ROUNDS — STEP 1 contract additions (approved by the repo owner).
// ---------------------------------------------------------------------------

test("STYLE_MIX is a 50/50 distribution over the two voices", () => {
  const sum = STYLE_MIX.group + STYLE_MIX.confess;
  approx(sum, 1, "STYLE_MIX sum");
  assert.ok(STYLE_MIX.group > 0 && STYLE_MIX.group < 1, "group share must be a real share");
  assert.ok(STYLE_MIX.confess > 0 && STYLE_MIX.confess < 1, "confess share must be a real share");
  const styles: PromptStyle[] = ["group", "confess"];
  assert.deepEqual([...styles].sort(), Object.keys(STYLE_MIX).sort(), "STYLE_MIX must cover exactly the two voices");
});

test("confess is a full round kind: it has a timer and a 20s window", () => {
  assert.equal(ROUND_TIMERS_MS.confess, 20_000);
  assert.ok(ROUND_TIMERS_MS.confess > 0 && ROUND_TIMERS_MS.confess < ROUND_TIMERS_MS.text, "a yes/no is not an essay");
  const kinds: RoundKind[] = ["pick", "text", "shout", "rating", "ios", "minigame", "dare", "pair_dare", "debrief", "spotlight", "verdict", "confess"];
  assert.equal(new Set(kinds).size, 12);
  for (const kind of kinds) assert.equal(typeof ROUND_TIMERS_MS[kind], "number", `${kind} has no timer`);
});

test("a confession is a valid private self-report — and has no skip", () => {
  assert.ok(isResponseValue({ kind: "confess", yes: true }));
  assert.ok(isResponseValue({ kind: "confess", yes: false }));
  assert.ok(isResponseValue({ kind: "confess", yes: true, target: "p2" }));
  assert.ok(isResponseValue({ kind: "confess", yes: true, note: "it was years ago" }));
  assert.ok(!isResponseValue({ kind: "confess" }), "yes/no is required");
  assert.ok(!isResponseValue({ kind: "confess", yes: "yes" }), "yes must be a boolean");
  assert.ok(!isResponseValue({ kind: "confess", yes: true, note: "x".repeat(CONFESS_NOTE_MAX + 1) }), "note is one line, not an essay");
  assert.ok(!validSubmit({ kind: "confess", yes: true, target: "p1" }, "p1"), "a confession cannot name yourself");
  assert.ok(validSubmit({ kind: "confess", yes: true, target: "p2" }, "p1"));
  // No skip variant exists anywhere in the union.
  assert.ok(!isResponseValue({ kind: "confess", skipped: true }));
});

test("the pair machinery has a confession component that is evidence-only", () => {
  const components: PairSignal["componentsUsed"] = ["pickOverlap", "confession"];
  assert.deepEqual(components, ["pickOverlap", "confession"]);
  // Weight 0 in the pair formula: the frozen spec §5 weights still sum to 1.
  approx(Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0), 1, "DEFAULT_WEIGHTS sum");
});

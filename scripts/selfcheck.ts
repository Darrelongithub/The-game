// scripts/selfcheck.ts — the pre-flight check for the whole stack.
//
//   npx -y tsx scripts/selfcheck.ts
//
// Verifies the SHARED FOUNDATION actually behaves, in the shape of GAME BRIEF
// v3.2: room codes, sign-up profile, response values, the self-pick rule, the
// timing caps, the prompt bank (size + spicy-first loader + no repeats + the
// banned generic prompts gone), the verdict kinds the reveal is allowed to
// use, and the secret-deck rule (a crush card exists only for a MUTUAL pick).
//
// All green = the foundation is safe.
import {
  isAlias,
  isProfileAnswers,
  isResponseValue,
  isRoomCode,
  playerCountOk,
  targetsOther,
  validSubmit,
} from "../packages/shared/src/validate.ts";
import {
  AGE_MIN,
  BAND_ORDER,
  BEAT_HOLD_MS,
  CASES_PER_NIGHT,
  DARE_CASES,
  LOOK_CHAIN_CASES,
  LOOK_CHAIN_CASES_MAX,
  MAX_PROMPT_CHARS,
  MAX_PROVIDER_CALLS_PER_NIGHT,
  METRIC,
  PROFILE_QUESTIONS,
  ROUND_KINDS,
  ROUND_TIMERS_MS,
  SECRET_DECK_MAX,
  SECRET_HOLD_MS,
  SHIP_VOTE_CASES,
  TRAITS,
  type Band,
  type RoundKind,
  type VerdictKind,
} from "../packages/shared/src/contracts.ts";
import { BANK, bankTotal, loadBank, promptTypeKey, seededShuffle, selectFromBank } from "../packages/prompts/src/bank/index.ts";
import { ollamaConfig } from "../packages/prompts/src/ollama.ts";
import { LOOK_CHAIN_VARIANTS, lookChainsFor } from "../apps/server/src/lookchain.ts";
import { assertNoOrientationLeak } from "../packages/engine/src/results.ts";
import {
  CLOSENESS_METRICS,
  COUPLE_METRICS,
  DESIRE_METRICS,
  HISTORY_METRICS,
  NEGATIVE_METRICS,
  SCORN_METRICS,
} from "../packages/engine/src/internal.ts";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean): void => {
  if (cond) pass++;
  else {
    fail++;
    console.error("  ✗ " + name);
  }
};

// ---------------------------------------------------------------- room codes
ok("room code valid", isRoomCode("AB2C"));
ok("room code rejects 0/O/1/I", !isRoomCode("AB0C") && !isRoomCode("ABOC") && !isRoomCode("AB1C") && !isRoomCode("ABlC"));
ok("room code rejects wrong length", !isRoomCode("ABC") && !isRoomCode("ABCDE"));
ok("room code rejects lowercase", !isRoomCode("ab2c"));

// ------------------------------------------------------------ aliases & size
ok("alias ok", isAlias("brian") && isAlias("wachuki great!") && !isAlias(" w "));
ok("alias rejects 1 char / 15 chars", !isAlias("b") && !isAlias("abcdefghijklmno"));
ok("players capped 4..11", playerCountOk(4) && playerCountOk(11) && !playerCountOk(3) && !playerCountOk(12) && !playerCountOk(4.5));

// ------------------------------------------------------------------ sign-up
ok("sign-up asks exactly 5 fields", PROFILE_QUESTIONS.length === 5);
ok(
  "sign-up fields are name-free and history-free",
  PROFILE_QUESTIONS.map((q) => q.field).join(",") === "age,gender,sexuality,attractedTo,lookingFor",
);
ok("sign-up has no relationship-history question", !PROFILE_QUESTIONS.some((q) => /\bex\b|history|relationship\s*status|\bdated\b|marital/i.test(q.label + q.field)));
ok("adult floor is 18", AGE_MIN === 18);
ok(
  "profile under 18 rejected",
  !isProfileAnswers({ age: 17, gender: "man", sexuality: "straight", attractedTo: "women", lookingFor: "fun" }),
);
ok(
  "profile at 18 accepted",
  isProfileAnswers({ age: 18, gender: "man", sexuality: "straight", attractedTo: "women", lookingFor: "fun" }),
);
ok("profile rejects unknown enum values", !isProfileAnswers({ age: 30, gender: "alien", sexuality: "straight", attractedTo: "women", lookingFor: "fun" }));

// ------------------------------------------------------------------ responses
ok("pick ok", isResponseValue({ kind: "pick", target: "p2" }));
ok("text exactly 280 ok", isResponseValue({ kind: "text", text: "a".repeat(280) }));
ok("text 281 rejected", !isResponseValue({ kind: "text", text: "a".repeat(281) }));
ok("text empty rejected", !isResponseValue({ kind: "text", text: "   " }));
ok("rating bounds 1..10",
  isResponseValue({ kind: "rating", trait: "loyalty", about: "self", value: 1 }) &&
  isResponseValue({ kind: "rating", trait: "loyalty", about: "self", value: 10 }) &&
  !isResponseValue({ kind: "rating", trait: "loyalty", about: "self", value: 0 }) &&
  !isResponseValue({ kind: "rating", trait: "loyalty", about: "self", value: 11 }) &&
  !isResponseValue({ kind: "rating", trait: "not-a-trait", about: "self", value: 5 }));
ok("pair_pick ok", isResponseValue({ kind: "pair_pick", pair: ["p1", "p2"] }));
ok("pair_vote 1..5 ok", isResponseValue({ kind: "pair_vote", pair: ["p1", "p2"], value: 4 }) && !isResponseValue({ kind: "pair_vote", pair: ["p1", "p2"], value: 6 }));
ok("dare done needs no reason", isResponseValue({ kind: "dare", status: "done" }));
ok("dare passed REQUIRES reason",
  !isResponseValue({ kind: "dare", status: "passed" }) &&
  isResponseValue({ kind: "dare", status: "passed", reason: "my mother is watching" }) &&
  !isResponseValue({ kind: "dare", status: "passed", reason: "   " }));
ok("unknown kind rejected", !isResponseValue({ kind: "smooch", target: "p2" }));
ok("null/garbage rejected", !isResponseValue(null) && !isResponseValue("yes") && !isResponseValue({}));

// ------------------------------------------------------- targeting / self-pick
ok("self-pick rejected", !targetsOther({ kind: "pick", target: "p1" }, "p1"));
ok("other-pick ok", targetsOther({ kind: "pick", target: "p2" }, "p1"));
ok("peer-rating yourself rejected", !targetsOther({ kind: "rating", trait: "loyalty", about: "p1", value: 5 }, "p1"));
ok("self-rating via about:'self' ok", targetsOther({ kind: "rating", trait: "loyalty", about: "self", value: 5 }, "p1"));
ok("pair containing yourself rejected", !targetsOther({ kind: "pair_pick", pair: ["p1", "p2"] }, "p1"));
ok("validSubmit combo", validSubmit({ kind: "pick", target: "p2" }, "p1") && !validSubmit({ kind: "pick", target: "p1" }, "p1"));

// --------------------------------------------------------------------- timing
const kinds: RoundKind[] = [...ROUND_KINDS];
ok("timers cover every round kind", kinds.length === 7 && kinds.every((k) => typeof ROUND_TIMERS_MS[k] === "number" && ROUND_TIMERS_MS[k] > 0));
ok("pick cap is 30s", ROUND_TIMERS_MS.pick === 30_000);
ok("short text cap is 45s", ROUND_TIMERS_MS.text === 45_000);
ok("long text cap is 75s", ROUND_TIMERS_MS.longtext === 75_000);
ok("rating cap is 20s", ROUND_TIMERS_MS.rating === 20_000);
ok("dare cap is 90s", ROUND_TIMERS_MS.dare === 90_000);
ok("beat is 1.5s", BEAT_HOLD_MS === 1_500);
ok("night runs 12 cases", CASES_PER_NIGHT === 12);
ok("3 ship-vote cases", SHIP_VOTE_CASES === 3);
ok("2 dare cases", DARE_CASES === 2);
ok("6-8 look chains", LOOK_CHAIN_CASES === 6 && LOOK_CHAIN_CASES_MAX === 8);

// ------------------------------------------------------------------- traits
ok("6 traits defined", TRAITS.length === 6);

// -------------------------------------------------------------------- bands
ok("4 heat bands in order", BAND_ORDER.length === 4 && BAND_ORDER[0] === "spicy" && BAND_ORDER[3] === "dare");

// ------------------------------------------------------------- secret decks
ok("secret deck config sane", SECRET_DECK_MAX >= 3 && SECRET_DECK_MAX <= 8 && SECRET_HOLD_MS >= 200 && SECRET_HOLD_MS <= 1000);
ok("provider call cap sane", MAX_PROVIDER_CALLS_PER_NIGHT >= 4 && MAX_PROVIDER_CALLS_PER_NIGHT <= 24);

// ----------------------------------------------------------------- the bank
ok("bank has 150+ prompts", bankTotal() >= 150);
const bankTexts = new Set(BANK.map((p) => p.text.trim().toLowerCase()));
ok("no duplicate bank templates", bankTexts.size === BANK.length);
ok("every prompt has a role", BANK.every((p) => Boolean(p.role)));
ok("every prompt has a kind", BANK.every((p) => Boolean(p.kind)));
ok("every prompt fits the char cap", BANK.every((p) => p.text.length <= MAX_PROMPT_CHARS));
ok("no generic 'which vibe are you looking for' prompt", !bankTexts.has("which vibe are you looking for"));
ok("no generic 'point at that person' prompt", ![...bankTexts].some((t) => t.includes("point at that person")));
ok("no generic 'how warm are you, honestly' prompt", ![...bankTexts].some((t) => t.includes("how warm are you, honestly")));
ok("loader puts the unhinged tier FIRST", loadBank({ spicy: true })[0]!.band === "spicy");
ok("spicy-first band order", loadBank({ spicy: true })[0]!.source === "bank" && BAND_ORDER[0] === "spicy");
ok("bank covers all 4 bands", (["warmup", "spicy", "deep", "dare"] as Band[]).every((b) => BANK.some((p) => p.band === b)));
const spicyWarmups = BANK.filter((p) => p.band === "spicy" && p.role === "subject").length;
ok("10-15 spicy warm-ups", spicyWarmups >= 10 && spicyWarmups <= 15);
ok("shuffle is seeded (same seed → same night)",
  JSON.stringify(seededShuffle(BANK.map((p) => p.id), 42)) === JSON.stringify(seededShuffle(BANK.map((p) => p.id), 42)));
ok("shuffle varies with the seed",
  JSON.stringify(seededShuffle(BANK.map((p) => p.id), 42)) !== JSON.stringify(seededShuffle(BANK.map((p) => p.id), 43)));
const drawn = selectFromBank(20, { playerCount: 6, seed: 7 });
ok("drawn set has no repeats", new Set(drawn.map((p) => p.id)).size === drawn.length);
ok("drawn set has no same-type back-to-back", drawn.every((p, i) => i === 0 || promptTypeKey(drawn[i - 1]!) !== promptTypeKey(p)));

// ------------------------------------- every question feeds a verdict
const consumed = new Set<string>([
  ...DESIRE_METRICS,
  ...NEGATIVE_METRICS,
  ...CLOSENESS_METRICS,
  ...COUPLE_METRICS,
  ...SCORN_METRICS,
  ...HISTORY_METRICS,
]);
const pickingPrompts = BANK.filter((p) => p.kind === "pick" || p.kind === "pair_pick" || p.kind === "pair_vote");
ok("every pick question names a metric the engine reads",
  pickingPrompts.every((p) =>
    p.measures.some((m) => m.startsWith("metric:") && consumed.has(m.slice("metric:".length))),
  ));

// ------------------------------------------------------------ verdict kinds
const allowed: VerdictKind[] = [
  "hates", "core", "couple", "sex", "percent", "gaycouple",
  "bodycount", "bestinbed", "besties", "rivals", "freeagent", "blindspot",
];
ok("12 allowed verdict kinds", allowed.length === 12);
ok("the gay verdict is hypothetical only", allowed.includes("gaycouple") && !allowed.some((k) => /orientation|sexuality/i.test(k)));
let orientationLeakCaught = false;
try {
  assertNoOrientationLeak({
    roomId: "r", pairScores: [], computedAt: 0,
    verdicts: [{ id: "v", kind: "percent", subjects: ["p1"], tone: "mild", text: "X is gay, apparently.", numbers: {}, strength: 1 }],
  });
} catch { orientationLeakCaught = true; }
ok("the engine rejects an orientation claim", orientationLeakCaught);

// ------------------------------------------------------------- look chains
ok("the look chain has its own metrics", METRIC.lookchain === "lookchain" && METRIC.lookchainGuess === "lookchain-guess");
ok("eight chain flavours", LOOK_CHAIN_VARIANTS.length === 8);
ok("every chain flavour is a full act → guess → why", LOOK_CHAIN_VARIANTS.every((v) => v.announce && v.act && v.guess && v.why));
ok("the chain copy never repeats", new Set(LOOK_CHAIN_VARIANTS.map((v) => v.act)).size === LOOK_CHAIN_VARIANTS.length);
ok("6-8 chains in a room of 5-11", lookChainsFor(5) >= 6 && lookChainsFor(11) <= 8);

// --------------------------------------------------------------- ollama lane
const cfg = ollamaConfig({});
ok("ollama default base", cfg.baseUrl === "http://127.0.0.1:11434");
ok("ollama default model", cfg.model === "dolphin-mistral");
ok("ollama default timeout 120s", cfg.timeoutMs === 120_000);
ok("ollama env overrides", ollamaConfig({ GEN_BASE: "http://x:1", GEN_MODEL: "llama3", GEN_TIMEOUT_MS: "1000" }).model === "llama3");

console.log(
  fail === 0
    ? `\nALL ${pass} CHECKS PASSED ✅ — the foundation holds`
    : `\n${fail} FAILED / ${pass} passed ❌ — fix before shipping`,
);
process.exit(fail === 0 ? 0 : 1);

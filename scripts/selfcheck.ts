// scripts/selfcheck.ts — run BEFORE spawning any agent:
//   npx -y tsx scripts/selfcheck.ts
// Verifies the shared foundation actually behaves. All green = safe to start.
declare const process: { exit: (code?: number) => void }; // keep this file dependency-free
import {
    isRoomCode, isAlias, isResponseValue, targetsOther, validSubmit, playerCountOk,
} from "../packages/shared/src/validate.ts";
import {
    ROUND_TIMERS_MS, TRAITS, HEAT_ORDER, SECRET_DECK_MAX, SECRET_HOLD_MS,
    MAX_PROVIDER_CALLS_PER_NIGHT, type RoundKind,
} from "../packages/shared/src/contracts.ts";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { if (cond) pass++; else { fail++; console.error("  ✗ " + name); } };

// room codes
ok("room code valid", isRoomCode("AB2C"));
ok("room code rejects 0/O/1/I", !isRoomCode("AB0C") && !isRoomCode("ABOC") && !isRoomCode("AB1C") && !isRoomCode("ABlC"));
ok("room code rejects wrong length", !isRoomCode("ABC") && !isRoomCode("ABCDE"));
ok("room code rejects lowercase", !isRoomCode("ab2c"));

// aliases & counts
ok("alias ok", isAlias("brian") && isAlias("wachuki great!") && !isAlias(" w "));
ok("alias rejects 1 char / 15 chars", !isAlias("b") && !isAlias("abcdefghijklmno"));
ok("players capped 4..11", playerCountOk(4) && playerCountOk(11) && !playerCountOk(3) && !playerCountOk(12) && !playerCountOk(4.5));

// responses
ok("pick ok", isResponseValue({ kind: "pick", target: "p2" }));
ok("text exactly 280 ok", isResponseValue({ kind: "text", text: "a".repeat(280) }));
ok("text 281 rejected", !isResponseValue({ kind: "text", text: "a".repeat(281) }));
ok("text empty rejected", !isResponseValue({ kind: "text", text: "   " }));
ok("shout ok", isResponseValue({ kind: "shout", word: "unhinged" }));
ok("shout 25 chars rejected", !isResponseValue({ kind: "shout", word: "a".repeat(25) }));
ok("rating bounds 1..10",
   isResponseValue({ kind: "rating", trait: "loyalty", about: "self", value: 1 }) &&
   isResponseValue({ kind: "rating", trait: "loyalty", about: "self", value: 10 }) &&
   !isResponseValue({ kind: "rating", trait: "loyalty", about: "self", value: 0 }) &&
   !isResponseValue({ kind: "rating", trait: "loyalty", about: "self", value: 11 }) &&
   !isResponseValue({ kind: "rating", trait: "vibes", about: "self", value: 5 }));
ok("ios bounds 1..7",
   isResponseValue({ kind: "ios", about: "p2", value: 7 }) &&
   !isResponseValue({ kind: "ios", about: "p2", value: 8 }) &&
   !isResponseValue({ kind: "ios", about: "p2", value: 0 }));
ok("minigame sane", isResponseValue({ kind: "minigame", score: 34 }) && !isResponseValue({ kind: "minigame", score: -1 }));
ok("dare done needs no reason", isResponseValue({ kind: "dare", status: "done" }));
ok("dare passed REQUIRES reason",
   !isResponseValue({ kind: "dare", status: "passed" }) &&
   isResponseValue({ kind: "dare", status: "passed", reason: "my mother is watching" }) &&
   !isResponseValue({ kind: "dare", status: "passed", reason: "   " }));
ok("unknown kind rejected", !isResponseValue({ kind: "smooch", target: "p2" }));
ok("null/garbage rejected", !isResponseValue(null) && !isResponseValue("yes") && !isResponseValue({}));

// targeting rules (the self-pick bug class)
ok("self-pick rejected", !targetsOther({ kind: "pick", target: "p1" }, "p1"));
ok("other-pick ok", targetsOther({ kind: "pick", target: "p2" }, "p1"));
ok("peer-rating yourself rejected", !targetsOther({ kind: "rating", trait: "loyalty", about: "p1", value: 5 }, "p1"));
ok("self-rating via about:'self' ok", targetsOther({ kind: "rating", trait: "loyalty", about: "self", value: 5 }, "p1"));
ok("ios about yourself rejected", !targetsOther({ kind: "ios", about: "p1", value: 3 }, "p1"));
ok("validSubmit combo", validSubmit({ kind: "pick", target: "p2" }, "p1") && !validSubmit({ kind: "pick", target: "p1" }, "p1"));

// contracts invariants
const kinds: RoundKind[] = ["pick", "text", "shout", "rating", "ios", "minigame", "dare", "pair_dare", "debrief"];
ok("timers cover all 9 round kinds", kinds.every((k) => typeof ROUND_TIMERS_MS[k] === "number" && ROUND_TIMERS_MS[k] > 0));
ok("6 traits defined", TRAITS.length === 6);
ok("4 heat phases in order", HEAT_ORDER.length === 4 && HEAT_ORDER[0] === "warmup" && HEAT_ORDER[3] === "dare");
ok("secret deck config sane", SECRET_DECK_MAX >= 3 && SECRET_DECK_MAX <= 8 && SECRET_HOLD_MS >= 200 && SECRET_HOLD_MS <= 1000);
ok("provider call cap sane", MAX_PROVIDER_CALLS_PER_NIGHT >= 5 && MAX_PROVIDER_CALLS_PER_NIGHT <= 12);

console.log(fail === 0 ? `\nALL ${pass} CHECKS PASSED ✅ — safe to spawn agents` : `\n${fail} FAILED / ${pass} passed ❌ — fix before spawning`);
process.exit(fail === 0 ? 0 : 1);

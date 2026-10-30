// packages/engine/test/fixtures.ts
// Hand-built logs. Every expected number in engine.test.ts is worked out
// from THESE records by hand (arithmetic in the test comments).
import {
  TRAITS,
  type LogRecord,
  type PlayerId,
  type PromptCoding,
  type RoomMeta,
  type RoundKind,
  type TraitId,
} from "../../shared/src/contracts.ts";
import { mulberry32 } from "../src/rng.ts";

const BASE_AT = 1_700_000_000_000;

export class LogBuilder {
  private seq = 0;
  readonly log: LogRecord[] = [];
  constructor(private readonly roomId: string) {}

  private push(
    roundId: string,
    roundKind: RoundKind,
    coding: PromptCoding,
    playerId: PlayerId,
    value: LogRecord["value"],
    latencyMs = 5000,
  ): void {
    this.seq++;
    this.log.push({
      roomId: this.roomId,
      roundId,
      playerId,
      roundKind,
      promptId: `${roundId}-prompt`,
      coding,
      value,
      at: BASE_AT + this.seq * 1000,
      latencyMs,
    });
  }

  pickRound(roundId: string, coding: PromptCoding, picks: [PlayerId, PlayerId][]): this {
    for (const [picker, target] of picks) this.push(roundId, "pick", coding, picker, { kind: "pick", target });
    return this;
  }
  text(roundId: string, playerId: PlayerId, text: string, roundKind: RoundKind = "text", latencyMs?: number): this {
    this.push(roundId, roundKind, "neutral", playerId, { kind: "text", text }, latencyMs);
    return this;
  }
  shout(roundId: string, playerId: PlayerId, word: string, latencyMs?: number): this {
    this.push(roundId, "shout", "neutral", playerId, { kind: "shout", word }, latencyMs);
    return this;
  }
  rating(roundId: string, playerId: PlayerId, trait: TraitId, about: "self" | PlayerId, value: number): this {
    this.push(roundId, "rating", "neutral", playerId, about === "self"
      ? { kind: "rating", trait, about: "self", value }
      : { kind: "rating", trait, about, value });
    return this;
  }
  ios(roundId: string, playerId: PlayerId, about: PlayerId, value: number): this {
    this.push(roundId, "ios", "neutral", playerId, { kind: "ios", about, value });
    return this;
  }
  minigame(roundId: string, playerId: PlayerId, score: number): this {
    this.push(roundId, "minigame", "neutral", playerId, { kind: "minigame", score });
    return this;
  }
  dare(roundId: string, playerId: PlayerId, status: "done" | "passed", reason?: string): this {
    this.push(roundId, "dare", "neutral", playerId, reason === undefined
      ? { kind: "dare", status }
      : { kind: "dare", status, reason });
    return this;
  }
}

export const meta5 = (roomId: string, revealOptIn: PlayerId[] = ["p1", "p2", "p3", "p4", "p5"]): RoomMeta => ({
  roomId,
  players: [
    { id: "p1", alias: "Ana" },
    { id: "p2", alias: "Ben" },
    { id: "p3", alias: "Cia" },
    { id: "p4", alias: "Dan" },
    { id: "p5", alias: "Eli" },
  ],
  revealOptIn,
  profiles: {},
});

// ---------------------------------------------------------------------------
// GOLDEN FIXTURE 1 — ship (p1,p2)+(p3,p4), besties (p3,p4)+(p1,p5),
// spark p1–p2, consensus C2→p1, blindspot p3 loyalty, one-sided p5→p1.
// ---------------------------------------------------------------------------
export function goldenLog1(): LogRecord[] {
  const b = new LogBuilder("room-g1");
  b.pickRound("C1", "couple", [["p1", "p2"], ["p2", "p1"], ["p3", "p4"], ["p4", "p5"], ["p5", "p1"]]);
  b.pickRound("C2", "couple", [["p1", "p2"], ["p2", "p1"], ["p3", "p1"], ["p4", "p1"], ["p5", "p1"]]);
  b.pickRound("F1", "friendship", [["p1", "p3"], ["p2", "p3"], ["p3", "p4"], ["p4", "p3"], ["p5", "p4"]]);
  b.pickRound("F2", "friendship", [["p1", "p3"], ["p2", "p4"], ["p3", "p4"], ["p4", "p3"], ["p5", "p1"]]);
  b.pickRound("N1", "neutral", [["p1", "p3"], ["p2", "p3"], ["p3", "p5"], ["p4", "p5"], ["p5", "p3"]]);

  // Self ratings (loyalty, warmth).
  const self: Record<PlayerId, [number, number]> = {
    p1: [8, 6], p2: [9, 7], p3: [5, 9], p4: [8, 5], p5: [7, 7],
  };
  for (const [p, [loyalty, warmth]] of Object.entries(self)) {
    b.rating("R-self", p, "loyalty", "self", loyalty);
    b.rating("R-self", p, "warmth", "self", warmth);
  }
  // Peer ratings: about → { rater: value }.
  const peerLoyalty: Record<PlayerId, Record<string, number>> = {
    p1: { p2: 7, p3: 8, p4: 8, p5: 9 },
    p2: { p1: 9, p3: 9, p4: 8, p5: 9 },
    p3: { p1: 8, p2: 9, p4: 8, p5: 8 },
    p4: { p1: 8, p2: 7, p3: 8, p5: 8 },
    p5: { p1: 7, p2: 7, p3: 6, p4: 7 },
  };
  const peerWarmth: Record<PlayerId, Record<string, number>> = {
    p1: { p2: 8, p3: 6, p4: 6, p5: 6 },
    p2: { p1: 7, p3: 7, p4: 8, p5: 7 },
    p3: { p1: 9, p2: 9, p4: 10, p5: 9 },
    p4: { p1: 5, p2: 6, p3: 5, p5: 5 },
    p5: { p1: 7, p2: 8, p3: 7, p4: 7 },
  };
  for (const [about, raters] of Object.entries(peerLoyalty)) {
    for (const [rater, v] of Object.entries(raters)) b.rating("R-peer", rater, "loyalty", about, v);
  }
  for (const [about, raters] of Object.entries(peerWarmth)) {
    for (const [rater, v] of Object.entries(raters)) b.rating("R-peer", rater, "warmth", about, v);
  }

  b.ios("IOS1", "p1", "p2", 6).ios("IOS1", "p2", "p1", 7)
    .ios("IOS2", "p3", "p4", 5).ios("IOS2", "p4", "p3", 5);

  // Pair-dare debrief: token sets {we,talked,about,Nairobi,and,laughed} vs
  // {we,laughed,about,Nairobi} → Jaccard 4/6.
  b.text("DB1", "p1", "we talked about Nairobi and laughed", "debrief");
  b.text("DB1", "p2", "we laughed about Nairobi", "debrief");

  // Digest colour (does not touch pair signals).
  b.text("T1", "p1", "the group chat screenshots would end careers in several counties");
  b.text("T1", "p2", "i would still pick this exact chaos every single friday");
  b.shout("S1", "p1", "chaos").shout("S1", "p2", "Chaos").shout("S1", "p3", "chaos").shout("S1", "p5", "chaos");
  b.minigame("M1", "p4", 42).minigame("M1", "p1", 20);
  b.dare("D1", "p2", "passed", "my shoes are cursed honestly").dare("D1", "p3", "done");
  return b.log;
}

// ---------------------------------------------------------------------------
// GOLDEN FIXTURE 2 — genuine toxic p4 (no jokers), rivals p1–p5,
// consensus X1+X2→p4, ship/besties (p1,p2)+(p3,p5), free agent p4.
// ---------------------------------------------------------------------------
export function goldenLog2(): LogRecord[] {
  const b = new LogBuilder("room-g2");
  b.pickRound("F1", "friendship", [["p1", "p2"], ["p2", "p3"], ["p3", "p1"], ["p4", "p5"], ["p5", "p2"]]);
  b.pickRound("F2", "friendship", [["p1", "p3"], ["p2", "p1"], ["p3", "p2"], ["p4", "p1"], ["p5", "p3"]]);
  b.pickRound("C1", "couple", [["p1", "p2"], ["p2", "p1"], ["p3", "p5"], ["p5", "p3"], ["p4", "p2"]]);
  b.pickRound("X1", "friction", [["p1", "p4"], ["p2", "p4"], ["p3", "p4"], ["p4", "p1"], ["p5", "p4"]]);
  b.pickRound("X2", "friction", [["p1", "p4"], ["p2", "p4"], ["p3", "p4"], ["p4", "p2"], ["p5", "p4"]]);
  b.pickRound("X3", "friction", [["p1", "p5"], ["p2", "p4"], ["p3", "p4"], ["p4", "p3"], ["p5", "p1"]]);
  b.pickRound("V1", "rivalry", [["p1", "p5"], ["p5", "p1"], ["p2", "p4"], ["p3", "p4"], ["p4", "p5"]]);
  b.pickRound("V2", "rivalry", [["p1", "p5"], ["p5", "p1"], ["p2", "p3"], ["p3", "p4"], ["p4", "p1"]]);

  const ids: PlayerId[] = ["p1", "p2", "p3", "p4", "p5"];
  for (const p of ids) b.rating("R-self", p, "loyalty", "self", 5);
  for (const about of ids) for (const rater of ids) {
    if (rater !== about) b.rating("R-peer", rater, "loyalty", about, 5);
  }
  b.ios("IOS1", "p1", "p5", 4).ios("IOS1", "p5", "p1", 4)
    .ios("IOS2", "p1", "p2", 6).ios("IOS2", "p2", "p1", 6)
    .ios("IOS3", "p3", "p5", 6).ios("IOS3", "p5", "p3", 6);
  // One authored text for the contempt-tag seam test.
  b.text("T1", "p4", "whatever, the room made its choices tonight");
  return b.log;
}

// ---------------------------------------------------------------------------
// JOKER FIXTURE — everyone names the same friend (p2) in every pick round.
// Every picker is joker-guarded, so p2 must get NO toxic claim at all.
// ---------------------------------------------------------------------------
export function jokerLog(): LogRecord[] {
  const b = new LogBuilder("room-joker");
  const everyonePicksP2: [PlayerId, PlayerId][] = [["p1", "p2"], ["p3", "p2"], ["p4", "p2"], ["p5", "p2"], ["p2", "p1"]];
  b.pickRound("JX1", "friction", everyonePicksP2);
  b.pickRound("JX2", "friction", everyonePicksP2);
  b.pickRound("JX3", "rivalry", everyonePicksP2);
  b.pickRound("JF1", "friendship", everyonePicksP2);
  b.pickRound("JF2", "friendship", everyonePicksP2);
  return b.log;
}

// ---------------------------------------------------------------------------
// UNIFORM-RANDOM ROOM — seeded so the test is a fixed, repeatable room,
// with enough rounds that chance levels concentrate. Expect ZERO
// high-confidence claims.
// ---------------------------------------------------------------------------
export const RANDOM_META: RoomMeta = {
  roomId: "room-random",
  players: ["p1", "p2", "p3", "p4", "p5", "p6"].map((id, i) => ({ id, alias: `Rnd${i + 1}` })),
  revealOptIn: ["p1", "p2", "p3", "p4", "p5", "p6"],
  profiles: {},
};

export function randomLog(seed: number, playerCount = RANDOM_META.players.length): LogRecord[] {
  const rng = mulberry32(seed);
  const ids = RANDOM_META.players.slice(0, playerCount).map((p) => p.id);
  const b = new LogBuilder("room-random");
  const codings: PromptCoding[] = ["couple", "friendship", "friction", "rivalry", "trust", "status"];
  const pickTarget = (self: PlayerId): PlayerId => {
    const others = ids.filter((x) => x !== self);
    return others[Math.floor(rng() * others.length)] as PlayerId;
  };
  for (let r = 0; r < 18; r++) {
    const coding = codings[r % codings.length] as PromptCoding;
    b.pickRound(`PR${r}`, coding, ids.map((id): [PlayerId, PlayerId] => [id, pickTarget(id)]));
  }
  const int = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
  for (const id of ids) for (const trait of TRAITS) b.rating("R-self", id, trait, "self", int(1, 10));
  for (const about of ids) for (const rater of ids) {
    if (rater === about) continue;
    for (const trait of TRAITS) b.rating("R-peer", rater, trait, about, int(1, 10));
  }
  for (let k = 0; k < 2; k++) {
    for (const from of ids) for (const to of ids) {
      if (from !== to) b.ios(`IOS${k}`, from, to, int(1, 7));
    }
  }
  return b.log;
}

// ---------------------------------------------------------------------------
// DIGEST FIXTURE — quotes filtering, dodges, gags, stats, teasers.
// ---------------------------------------------------------------------------
export function digestLog(): LogRecord[] {
  const b = new LogBuilder("room-digest");
  b.pickRound("DP1", "trust", [["p1", "p2"], ["p3", "p2"], ["p4", "p2"], ["p5", "p3"], ["p2", "p4"]]);
  b.text("DT1", "p1", "the screenshots from tonight would finish several careers");
  b.text("DT1", "p2", "nobody here can keep a secret past midnight honestly");
  b.text("DT1", "p3", "THE SCREENSHOTS FROM TONIGHT WOULD FINISH SEVERAL CAREERS"); // dup → dropped
  b.text("DT1", "p4", "too short really"); // <20 chars → dropped
  b.text("DT1", "p5", "🔥".repeat(30)); // emoji-only → dropped
  b.text("DT2", "p1", "word ".repeat(40).trim()); // >160 chars → dropped
  b.text("DDB", "p2", "we definitely did not discuss the group finances", "debrief"); // private → never quoted
  b.shout("DS1", "p1", "Chaos").shout("DS1", "p2", "chaos").shout("DS2", "p3", "CHAOS").shout("DS2", "p4", "lonely");
  b.minigame("DM1", "p3", 55).minigame("DM1", "p1", 12);
  b.dare("DD1", "p2", "passed", "absolutely not in these shoes");
  b.dare("DD2", "p2", "passed", "my mother follows this account");
  b.dare("DD1", "p1", "done");
  b.shout("DS3", "p4", "speedy", 250); // fastest finger tonight
  b.text("DT3", "p1", "a slow and extremely considered answer to everything", "text", 89000); // slowest
  b.rating("DR1", "p1", "chaos", "self", 9);
  b.rating("DR1", "p2", "chaos", "p1", 4);
  b.rating("DR1", "p3", "chaos", "p1", 6);
  return b.log;
}

// packages/engine/src/secrets.ts
// buildSecrets — spec §7 Secret Cards. Deterministic; numbers come ONLY
// from Claims and the NightDigest (never recomputed from any log — this
// function doesn't even receive one). Decks are returned only for players
// who actually have cards. Facts use "Player N" pseudonyms like the rest
// of the engine's copy; the server swaps aliases in after narration.
import {
  SECRET_DECK_MAX,
  type NightDigest,
  type PairSignal,
  type PlayerId,
  type Results,
  type RoomMeta,
  type SecretCard,
} from "../../shared/src/contracts.ts";
import {
  ENGINE_TUNING,
  formatNumber,
  pairKey,
  pseudoOf,
} from "./internal.ts";

const KIND_ORDER: SecretCard["kind"][] = ["spark", "onesided", "blindspot", "roomnote", "stat"];
const FACT_MAX_CHARS = 120; // spec §7: each secret fact ≤120 chars
const FACTS_MAX = 4;          // spec §7: 1–4 lines per card

const fit = (fact: string): string =>
  fact.length <= FACT_MAX_CHARS ? fact : `${fact.slice(0, FACT_MAX_CHARS - 1)}…`;

const card = (id: string, kind: SecretCard["kind"], title: string, facts: string[]): SecretCard => ({
  id,
  kind,
  title,
  facts: facts.slice(0, FACTS_MAX).map(fit),
});

export function buildSecrets(
  results: Results,
  digest: NightDigest,
  meta: RoomMeta,
): Map<PlayerId, SecretCard[]> {
  const optIn = new Set(meta.revealOptIn);
  const buckets = new Map<PlayerId, SecretCard[]>();
  const add = (player: PlayerId, c: SecretCard): void => {
    const arr = buckets.get(player);
    if (arr) arr.push(c);
    else buckets.set(player, [c]);
  };

  // ---------- spark: one card for EACH of the two (both must be revealOptIn) ----------
  for (const claim of results.claims) {
    if (claim.confidence === "low" || claim.type !== "spark" || claim.subjects.length !== 2) continue;
    const [x, y] = claim.subjects as [PlayerId, PlayerId];
    if (!optIn.has(x) || !optIn.has(y)) continue;
    for (const [holder, other] of [[x, y], [y, x]] as [PlayerId, PlayerId][]) {
      add(holder, card(`secret-spark-${holder}-${other}`, "spark", "A quiet spark", [
        `You and ${pseudoOf(meta, other)} picked each other on couple-coded rounds.`,
        ...claim.evidence.slice(0, 2),
      ]));
    }
  }

  // ---------- onesided: the PICKER's phone only (picker must be revealOptIn) ----------
  for (const claim of results.claims) {
    if (claim.confidence === "low" || claim.type !== "onesided" || claim.subjects.length !== 2) continue;
    const [picker, target] = claim.subjects as [PlayerId, PlayerId];
    if (!optIn.has(picker)) continue;
    add(picker, card(`secret-onesided-${picker}-${target}`, "onesided", "A one-way signal", [
      `Your picks kept landing on ${pseudoOf(meta, target)}.`,
      ...claim.evidence.slice(0, 2),
      `No pressure in that — the room is just data tonight.`,
    ]));
  }

  // ---------- blindspot: each player's top ≤3 self-vs-room gaps ----------
  const aliasToId = new Map(meta.players.map((p) => [p.alias, p.id]));
  const gapsByPlayer = new Map<PlayerId, NightDigest["selfVsRoom"]>();
  for (const entry of digest.selfVsRoom) {
    const id = aliasToId.get(entry.alias);
    if (!id) continue;
    const arr = gapsByPlayer.get(id);
    if (arr) arr.push(entry);
    else gapsByPlayer.set(id, [entry]);
  }
  for (const player of meta.players) {
    const gaps = (gapsByPlayer.get(player.id) ?? [])
      .filter((g) => Math.abs(g.self - g.roomMean) >= ENGINE_TUNING.blindspotSecretMinGap)
      .slice(0, 3); // digest is already sorted biggest-gap first
    if (gaps.length === 0) continue;
    add(player.id, card(`secret-blindspot-${player.id}`, "blindspot", "Your blind spot", gaps.map(
      (g) =>
        `You rated your ${g.trait} ${formatNumber(g.self)} out of 10; the room averaged ${formatNumber(g.roomMean)}.`,
    )));
  }

  // ---------- roomnote: med-confidence pair notes the engine did NOT publish ----------
  // Positive-only by construction (friendship/couple-coded pair signals for a
  // pair that is neither a public ship/besties pair nor a spark) — never
  // low-confidence, never unkind, never about toxic/rival material.
  {
    const publishedOrSparked = new Set<string>();
    for (const claim of results.claims) {
      if ((claim.type === "ship" || claim.type === "besties" || claim.type === "spark") && claim.subjects.length === 2) {
        publishedOrSparked.add(pairKey(claim.subjects[0] as PlayerId, claim.subjects[1] as PlayerId));
      }
    }
    const supportCount = (s: PairSignal): number => {
      let n = 0;
      if (s.pickOverlap > ENGINE_TUNING.support.pickOverlap) n++;
      if (s.mutualPick > ENGINE_TUNING.support.mutualPick) n++;
      if (s.debriefSim > ENGINE_TUNING.support.debriefSim) n++;
      if (s.iosMean >= ENGINE_TUNING.support.iosMean) n++;
      if (s.traitAgreement >= ENGINE_TUNING.support.traitAgreement) n++;
      return n;
    };
    for (const player of meta.players) {
      let best: PairSignal | undefined;
      let bestOther: PlayerId | undefined;
      for (const s of results.pairScores) {
        if (s.a !== player.id && s.b !== player.id) continue;
        if (publishedOrSparked.has(pairKey(s.a, s.b))) continue;
        if (s.coupleEvidence + s.friendEvidence === 0) continue;
        if (supportCount(s) !== 2) continue; // med confidence = exactly 2 signal types
        const other = s.a === player.id ? s.b : s.a;
        if (
          !best ||
          s.pairScore > best.pairScore ||
          (s.pairScore === best.pairScore && bestOther !== undefined && other < bestOther)
        ) {
          best = s;
          bestOther = other;
        }
      }
      if (best && bestOther) {
        add(player.id, card(`secret-roomnote-${player.id}-${bestOther}`, "roomnote", "A note from the room", [
          `Between you and ${pseudoOf(meta, bestOther)}, the picks kept quietly lining up.`,
          `Not a headline tonight — just a pattern worth knowing.`,
        ]));
      }
    }
  }

  // ---------- profile-derived notes: shared stated intent, never romantic inference ----------
  // Only the least-sensitive profile axis (tonight's intent) is compared. Both
  // people must explicitly opt in to reveal cards; private crush and dating
  // history answers are never used or exposed by inference.
  for (let i = 0; i < meta.players.length; i++) {
    const a = meta.players[i]!;
    for (let j = i + 1; j < meta.players.length; j++) {
      const b = meta.players[j]!;
      if (!optIn.has(a.id) || !optIn.has(b.id)) continue;
      const intent = meta.profiles[a.id]?.tonight;
      if (!intent || intent !== meta.profiles[b.id]?.tonight) continue;
      const label = ({ chaos: "a little chaos", vibes: "good vibes", feelings: "real feelings", mission: "a shared mission" } as const)[intent];
      add(a.id, card(`secret-profile-intent-${a.id}-${b.id}`, "roomnote", "A shared vibe", [
        `You and ${pseudoOf(meta, b.id)} both came looking for ${label}.`,
        `A shared intention is a conversation starter, not proof of compatibility.`,
      ]));
      add(b.id, card(`secret-profile-intent-${b.id}-${a.id}`, "roomnote", "A shared vibe", [
        `You and ${pseudoOf(meta, a.id)} both came looking for ${label}.`,
        `A shared intention is a conversation starter, not proof of compatibility.`,
      ]));
    }
  }

  // ---------- stat: that player's digest stats (dodges, speed, contradiction) ----------
  for (const player of meta.players) {
    const facts: string[] = [];
    const myDodges = digest.dodges.filter((d) => d.alias === player.alias);
    if (digest.stats.fastest?.alias === player.alias) {
      facts.push(`Quickest finger tonight: you answered in ${digest.stats.fastest.ms} milliseconds once.`);
    }
    if (digest.stats.slowest?.alias === player.alias) {
      facts.push(`You once took ${digest.stats.slowest.ms} milliseconds to answer. Contemplative.`);
    }
    if (digest.stats.tapWar?.alias === player.alias) {
      facts.push(`Tap-war champion: ${digest.stats.tapWar.score} taps. Officially a lot.`);
    }
    if (digest.stats.topDodger?.alias === player.alias) {
      facts.push(`Most "I can't" cards played tonight: yours.`);
    }
    if (myDodges.length > 0) {
      facts.push(
        myDodges.length === 1
          ? `You passed on a dare once. Your stated reason: "${myDodges[0]?.reason}"`
          : `You passed on dares ${myDodges.length} times. First stated reason: "${myDodges[0]?.reason}"`,
      );
      // One contradiction, if the digest holds one: high self-rated
      // honesty/chaos, then a dodge anyway.
      const gaps = gapsByPlayer.get(player.id) ?? [];
      const boasting = gaps.find(
        (g) => (g.trait === "honesty" || g.trait === "chaos") && g.self >= 8,
      );
      if (boasting) {
        facts.push(
          `You rated your ${boasting.trait} ${formatNumber(boasting.self)} out of 10 — then passed on a dare anyway.`,
        );
      }
    }
    if (facts.length > 0) {
      add(player.id, card(`secret-stat-${player.id}`, "stat", "Your night in numbers", facts));
    }
  }

  // ---------- fixed order spark → onesided → blindspot → roomnote → stat, capped ----------
  const decks = new Map<PlayerId, SecretCard[]>();
  for (const player of meta.players) {
    const cards = buckets.get(player.id);
    if (!cards || cards.length === 0) continue;
    const ordered = [...cards].sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind));
    decks.set(player.id, ordered.slice(0, SECRET_DECK_MAX));
  }
  return decks;
}

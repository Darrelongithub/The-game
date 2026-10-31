// packages/engine/src/secrets.ts
// SECRET CARDS — private, per-phone, hold-to-open.
//
// THE RULE THAT MATTERS: a crush card exists ONLY for a MUTUAL pick. If A
// picked B and B did not pick A, there is NO CARD AT ALL — not for A, not
// for B. There is no one-sided card. There is no "who picked you" card. The
// only thing a phone ever learns is: "You and X like each other."
//
// Other cards come from real data too:
//   blindspot  your self-rating vs what the room said about you
//   lookchain  you looked at someone; how many guessed, and why
//
// No data → no card. Never invent.
import {
    SECRET_DECK_MAX,
    type LogRecord,
    type MetricKey,
    type PlayerId,
    type Results,
    type RoomMeta,
    type SecretCard,
    type SecretDeckView,
    type TraitId,
    type Verdict,
} from "../../shared/src/contracts.ts";
import {
    ENGINE_TUNING,
    buildRatingIndex,
    clamp01,
    formatNumber,
    meanOf,
    pseudoOf,
} from "./internal.ts";
import { pickTally } from "./signals.ts";

// ---------------------------------------------------------------------------
// look chains
// ---------------------------------------------------------------------------

/**
 * A Look Chain is a four-step live moment:
 *   1. everybody looks at X
 *   2. X taps the person they are looking at (hidden from everyone else)
 *   3. everybody else guesses who X is looking at
 *   4. X says why
 *
 * The server stores the chain's outcome in the log as a `pick` by the actor
 * with the `lookchain` metric, the guesses as `pair_pick`-style records with
 * the `lookchain-guess` metric, and the reason as a `text`.
 */
export const METRIC_LOOKCHAIN = "lookchain" as MetricKey;
export const METRIC_LOOKCHAIN_GUESS = "lookchain-guess" as MetricKey;

export interface LookChainOutcome {
    /** The round the chain happened in — one chain per round. */
    roundId: string;
    actor: PlayerId;
    target: PlayerId;
    /** How many players guessed the target correctly. */
    guessedRight: number;
    /** How many players guessed at all. */
    guessers: number;
    /** X's reason, verbatim. */
    reason?: string;
    /** The chain's act line, e.g. "Look at someone you love." */
    act?: string;
}

/** Pull the look chains out of the log. */
export function lookChains(log: readonly LogRecord[]): LookChainOutcome[] {
    // A chain is identified by its ROUND, not by its actor: the same player
    // may look at somebody more than once in a night, and each of those is
    // its own chain with its own guesses and its own reason.
    const chains = new Map<string, LookChainOutcome>();
    for (const rec of log) {
        if (rec.metric === METRIC_LOOKCHAIN && rec.value.kind === "pick") {
            chains.set(rec.roundId, {
                roundId: rec.roundId,
                actor: rec.playerId,
                target: rec.value.target,
                guessedRight: 0,
                guessers: 0,
            });
        }
    }
    // Second pass: the guesses share the chain's roundId with the act.
    for (const rec of log) {
        if (rec.metric !== METRIC_LOOKCHAIN_GUESS || rec.value.kind !== "pick") continue;
        const chain = chains.get(rec.roundId);
        if (!chain) continue;
        chain.guessers += 1;
        if (rec.value.target === chain.target) chain.guessedRight += 1;
    }
    // Third pass: the actor's own reason for the look.
    for (const rec of log) {
        if (rec.metric !== METRIC_LOOKCHAIN || rec.value.kind !== "text") continue;
        const chain = chains.get(rec.roundId);
        if (chain && chain.actor === rec.playerId) chain.reason = rec.value.text;
    }
    return [...chains.values()];
}

// ---------------------------------------------------------------------------
// crush — MUTUAL ONLY
// ---------------------------------------------------------------------------

export interface CrushPair {
    a: PlayerId;
    b: PlayerId;
    /** How many times each picked the other (>=1 each). */
    strength: number;
}

/**
 * The mutual crush pairs in the log.
 *
 * A pair qualifies ONLY when BOTH players picked the other for a
 * crush-ish metric. One-sided picks are invisible here by construction —
 * they never produce a card.
 */
export function mutualCrushes(log: readonly LogRecord[]): CrushPair[] {
    const tally = pickTally(log, "crush");
    const out: CrushPair[] = [];
    const seen = new Set<string>();
    for (const [a, setA] of tally) {
        for (const b of setA) {
            if (a === b) continue;
            const setB = tally.get(b);
            if (!setB || !setB.has(a)) continue;
            // Each pair counts ONCE, no matter which side we found it from.
            const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ a, b, strength: Math.min(setA.size, setB.size) });
        }
    }
    out.sort((x, y) => y.strength - x.strength);
    return out;
}

// ---------------------------------------------------------------------------
// blind spot
// ---------------------------------------------------------------------------

export interface BlindSpotFinding {
    id: PlayerId;
    trait: TraitId;
    self: number;
    room: number;
    raters: number;
}

export function blindSpots(log: readonly LogRecord[]): BlindSpotFinding[] {
    const idx = buildRatingIndex(log);
    const traits: TraitId[] = ["loyalty", "chaos", "reliability", "warmth", "honesty", "spice"];
    const out: BlindSpotFinding[] = [];
    for (const [id, selfMap] of idx.self) {
        for (const trait of traits) {
            const self = selfMap.get(trait);
            if (self === undefined) continue;
            const peerMap = idx.peerByRater.get(id)?.get(trait);
            if (!peerMap) continue;
            const ratings = [...peerMap.values()];
            if (ratings.length < ENGINE_TUNING.blindspotMinRaters) continue;
            const room = meanOf(ratings);
            if (Math.abs(self - room) < ENGINE_TUNING.blindspotMinGap) continue;
            out.push({ id, trait, self, room, raters: ratings.length });
        }
    }
    out.sort((x, y) => Math.abs(y.self - y.room) - Math.abs(x.self - x.room));
    return out;
}

// ---------------------------------------------------------------------------
// the deck builder
// ---------------------------------------------------------------------------

/**
 * Build every player's private deck.
 *
 * Returns a map keyed by player id. A player with no real data gets NO deck
 * entry at all (the server simply never sends them a `secrets` event).
 */
export function buildSecrets(
    results: Results,
    log: readonly LogRecord[],
    meta: RoomMeta,
): Map<PlayerId, SecretCard[]> {
    const decks = new Map<PlayerId, SecretCard[]>();
    const add = (id: PlayerId, card: SecretCard): void => {
        const list = decks.get(id) ?? [];
        if (list.length >= SECRET_DECK_MAX) return;
        list.push(card);
        decks.set(id, list);
    };

    // ---- 1. mutual crush card (ONLY the two mutual pickers) ----
    for (const crush of mutualCrushes(log)) {
        const aName = pseudoOf(meta, crush.a);
        const bName = pseudoOf(meta, crush.b);
        add(crush.a, {
            id: `crush-${crush.a}-${crush.b}`,
            kind: "crush",
            title: "Mutual crush",
            facts: [`You and ${bName} like each other.`],
        });
        add(crush.b, {
            id: `crush-${crush.b}-${crush.a}`,
            kind: "crush",
            title: "Mutual crush",
            facts: [`You and ${aName} like each other.`],
        });
    }

    // ---- 2. blind spot card ----
    const traitLabel: Record<TraitId, string> = {
        loyalty: "loyal",
        chaos: "chaotic",
        reliability: "reliable",
        warmth: "warm",
        honesty: "honest",
        spice: "hot",
    };
    for (const bs of blindSpots(log)) {
        const facts = [
            `You rated yourself ${formatNumber(bs.self)}/10 ${traitLabel[bs.trait]}.`,
            `The room said ${formatNumber(bs.room)}.`,
        ];
        if (bs.self > bs.room) facts.push("You are your own biggest fan.");
        else facts.push("You have been underselling yourself all night.");
        add(bs.id, {
            id: `blindspot-${bs.id}-${bs.trait}`,
            kind: "blindspot",
            title: "Blind spot",
            facts,
        });
    }

    // ---- 3. look chain card ----
    for (const chain of lookChains(log)) {
        const targetName = pseudoOf(meta, chain.target);
        const facts: string[] = [];
        if (chain.act) facts.push(chain.act);
        facts.push(`You looked at ${targetName}.`);
        if (chain.guessers > 0) {
            facts.push(
                `${chain.guessedRight} of ${chain.guessers} guessed right.`,
            );
        } else {
            facts.push("Nobody guessed right.");
        }
        if (chain.reason) facts.push(`"${chain.reason}"`);
        add(chain.actor, {
            id: `lookchain-${chain.roundId}`,
            kind: "lookchain",
            title: "Look chain",
            facts,
        });
    }

    // NOTE: there is deliberately NO fourth source. The brief allows exactly
    // three card kinds — mutual crush, blind spot, look chain — and every one
    // of them must come from real answers. A "hates"/"rivals" verdict is
    // public copy on the laptop reveal; it never becomes a secret card.

    return decks;
}

/** The view for one player's deck. */
export function deckViewOf(cards: readonly SecretCard[]): SecretDeckView {
    return { cards: [...cards] };
}

/** How strong a crush is, 0..1 — used for ordering. */
export function crushStrength(strength: number, playerCount: number): number {
    return clamp01(strength / Math.max(1, playerCount - 1));
}

/** Every verdict that mentions a given player. */
export function verdictsFor(results: Results, id: PlayerId): Verdict[] {
    return results.verdicts.filter((v) => v.subjects.includes(id));
}

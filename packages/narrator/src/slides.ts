// packages/narrator/src/slides.ts
// buildSkeleton — PURE, deterministic, broadcast-safe.
//
// Turns engine output (Results + NightDigest) into the public finale story:
//
//   title → besties (tease/escalate/land) → rivals → consensus → blind spots
//   → digest block (QUOTE → DODGE REPORT → SPEED RUNNER → contradiction)
//   → toxic (Group Announcement) → SHIP (biggest) → free agent → closing
//
// Every slide is public. Private material (onesided / spark claims) NEVER
// appears here — that is Secret Card territory and it lives on one phone only.
//
// Engine `evidence` strings are the fallback `body` of every slide, so the
// whole story renders with no API key at all.

import {
  type Claim,
  type ClaimType,
  type Confidence,
  type DigestQuote,
  type FinaleSlide,
  type NightDigest,
  type Results,
  type SlideBeat,
  type TraitId,
} from "../../shared/src/contracts.ts";
import {
  derivePseudonyms,
  naturalCompare,
  normAlias,
  pseudonymForAlias,
  pseudonymOf,
  type Pseudonyms,
  type RosterInput,
} from "./roster.ts";
import { digitsIn, LIMITS, playerTokensIn } from "./validate.ts";

export const NARRATOR_TUNING = {
  maxConsensusSlides: 3,
  maxBlindspotSlides: 3,
  maxDodgeSlides: 6,
  bodyMaxChars: LIMITS.bodyMaxChars,
  titleMaxWords: LIMITS.titleMaxWords,
} as const;

/** What a model is allowed to know about one slide (internal side channel). */
export interface SkeletonSource {
  claimId?: string;
  claimType?: ClaimType;
  subjects: string[];
  /** "Player N" tokens this slide may legally use. */
  players: Set<string>;
  /** Digit strings the model may repeat (claim.numbers + engine text). */
  numbers: Set<string>;
  /** Engine text handed to the model as the fallback copy. */
  material: string;
  /** Verbatim digest material that must be quoted exactly, never reworded. */
  verbatim?: string;
}

const SOURCES = new WeakMap<FinaleSlide, SkeletonSource>();

export const sourceOf = (slide: FinaleSlide): SkeletonSource | undefined =>
  SOURCES.get(slide);

/** Used by write.ts when a merged slide copy replaces the engine object. */
export const registerSource = (slide: FinaleSlide, source: SkeletonSource): FinaleSlide => {
  SOURCES.set(slide, source);
  return slide;
};

// --------------------------------------------------------------------------
// small deterministic helpers
// --------------------------------------------------------------------------

export function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const head = trimmed.slice(0, Math.max(1, max - 1));
  const cut = head.lastIndexOf(" ");
  const kept = cut > max * 0.5 ? head.slice(0, cut) : head;
  return `${kept.replace(/[\s,;:.\-–—]+$/, "")}…`;
}

/** Prefer the longest evidence line that fits the slide body budget. */
export function bodyFromEvidence(
  evidence: readonly string[] | undefined,
  max: number = NARRATOR_TUNING.bodyMaxChars,
): string | undefined {
  const lines = (evidence ?? []).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return undefined;
  const joined = lines.join(" ");
  if (joined.length <= max) return joined;
  const fitting = [...lines].sort((a, b) => b.length - a.length)[0];
  if (fitting && fitting.length <= max) return fitting;
  return clip(joined, max);
}

const numberStrings = (numbers: Record<string, number> | undefined): string[] =>
  numbers ? Object.values(numbers).map((value) => String(value)) : [];

/** Rank helper: high > med > low (spec §5). */
const CONF_RANK: Record<Confidence, number> = { low: 1, med: 2, high: 3 };

const PRIVATE_TYPES: ReadonlySet<ClaimType> = new Set<ClaimType>(["onesided", "spark"]);
const NEGATIVE_TYPES: ReadonlySet<ClaimType> = new Set<ClaimType>(["toxic", "rival"]);

/**
 * Defensive publication gate. The engine already keeps private claims private
 * and never publishes low-confidence negatives — the narrator re-checks so a
 * single upstream bug can never put a secret on every phone.
 */
export function isPublishable(claim: Claim): boolean {
  if (claim.audience !== "public") return false;
  if (PRIVATE_TYPES.has(claim.type)) return false;
  if (NEGATIVE_TYPES.has(claim.type) && claim.confidence === "low") return false;
  return true;
}

function pairScoreOf(claim: Claim, results: Results): number {
  const [a, b] = claim.subjects;
  if (!a || !b) return 0;
  const pair = results.pairScores.find(
    (candidate) =>
      (candidate.a === a && candidate.b === b) || (candidate.a === b && candidate.b === a),
  );
  return pair ? pair.pairScore : 0;
}

function rankClaims(
  claims: readonly Claim[],
  score: (claim: Claim) => number,
): Claim[] {
  return [...claims].sort(
    (x, y) =>
      CONF_RANK[y.confidence] - CONF_RANK[x.confidence] ||
      score(y) - score(x) ||
      naturalCompare(x.id, y.id),
  );
}

const numeric = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

// --------------------------------------------------------------------------
// claim → slide source
// --------------------------------------------------------------------------

function sourceForClaim(claim: Claim, ps: Pseudonyms): SkeletonSource {
  const subjects = claim.subjects
    .map((id) => pseudonymOf(ps, id))
    .filter((token): token is string => Boolean(token));
  const material = claim.evidence.join(" ");
  return {
    claimId: claim.id,
    claimType: claim.type,
    subjects,
    players: new Set([...subjects, ...playerTokensIn(claim.evidence)]),
    numbers: new Set([...numberStrings(claim.numbers), ...digitsIn(claim.evidence)]),
    material,
  };
}

interface SlideDraft {
  beat: SlideBeat;
  flavor?: FinaleSlide["flavor"];
  claimId?: string;
  title: string;
  body?: string;
  numbers?: Record<string, number>;
}

function materialize(draft: SlideDraft): FinaleSlide {
  const slide: FinaleSlide = {
    beat: draft.beat,
    title: clip(draft.title, LIMITS.titleMaxChars),
  };
  if (draft.flavor) slide.flavor = draft.flavor;
  if (draft.claimId) slide.claimId = draft.claimId;
  const body = draft.body?.trim();
  if (body && body.length > 0) slide.body = clip(body, NARRATOR_TUNING.bodyMaxChars);
  if (draft.numbers) slide.numbers = { ...draft.numbers };
  return slide;
}

const SECTION_FALLBACK: Partial<Record<ClaimType, string>> = {
  besties: "Friend-coded signals do not lie. The matching called it early.",
  rival: "Two people keep circling each other. The room saw it first.",
  consensus: "The room keeps landing on the same answer.",
  blindspot: "The room sees you a little differently than you see yourself.",
  toxic: "The nominations came in and they all pointed the same way.",
  ship: "Highest pair score of the night. The matching has spoken.",
};

function claimBodies(claim: Claim): { evidenceBody?: string; fallback: string } {
  return {
    evidenceBody: bodyFromEvidence(claim.evidence),
    fallback: SECTION_FALLBACK[claim.type] ?? "The engine has spoken.",
  };
}

/**
 * Three-beat sections (besties, ship) must not repeat a line: the tease names
 * nobody, the escalation names the pair, the landing keeps the engine's last
 * (punch) line. Data-thin claims still produce three distinct, non-empty
 * bodies.
 */
function sectionBodies(
  claim: Claim,
  tease: string,
): { tease: string; escalate: string; land: string } {
  const max = NARRATOR_TUNING.bodyMaxChars;
  const lines = claim.evidence
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => clip(line, max));
  const fallback = SECTION_FALLBACK[claim.type] ?? "The engine has spoken.";
  if (lines.length === 0) return { tease, escalate: fallback, land: fallback };
  if (lines.length === 1) return { tease, escalate: fallback, land: lines[0] as string };

  const escalate = lines[0] as string;
  const last = lines[lines.length - 1] as string;
  if (last !== escalate) return { tease, escalate, land: last };
  const distinct = [...lines]
    .slice(1)
    .sort((a, b) => b.length - a.length)
    .find((line) => line !== escalate);
  return { tease, escalate, land: clip(distinct ?? fallback, max) };
}

// --------------------------------------------------------------------------
// digest helpers
// --------------------------------------------------------------------------

function pickQuote(digest: NightDigest): DigestQuote | undefined {
  const usable = (digest.quotes ?? []).filter(
    (quote) => typeof quote.text === "string" && quote.text.trim().length > 0,
  );
  if (usable.length === 0) return undefined;
  const juicy = usable.find((quote) => {
    const length = quote.text.trim().length;
    return length >= 30 && length <= 130;
  });
  return juicy ?? usable[0];
}

function withAttribution(line: string, who: string | undefined, max: number): string {
  if (who) {
    const attributed = `${line} — ${who}`;
    if (attributed.length <= max) return attributed;
  }
  return line.length <= max ? line : clip(line, max);
}

interface DodgeLine {
  title: string;
  body: string;
  who?: string;
  reason: string;
}

function dodgeLine(alias: string, rawReason: string, ps: Pseudonyms): DodgeLine {
  const who = pseudonymForAlias(ps, alias);
  const reason = rawReason.trim();
  const quoted = `"${reason}"`;
  const attributed = `"${reason}" — ${who}`;
  const named = who ? `DODGE REPORT: ${who}` : "DODGE REPORT";
  if (who && attributed.length <= NARRATOR_TUNING.bodyMaxChars) {
    return { title: "DODGE REPORT", body: attributed, who, reason };
  }
  if (quoted.length <= NARRATOR_TUNING.bodyMaxChars) {
    return { title: named, body: quoted, who, reason };
  }
  return {
    title: named,
    body: clip(reason, NARRATOR_TUNING.bodyMaxChars),
    who,
    reason,
  };
}

interface Contradiction {
  who?: string;
  trait: TraitId;
  self: number;
  roomMean: number;
  dodges: number;
}

/**
 * Contradiction of the night.
 *
 * The frozen NightDigest has no `contradictions` field (see the contract
 * request in NOTES), so we derive one from data that IS in the digest:
 * someone who rates themselves highly, sits well above the room's read of
 * them, and still had "I can't" excuses on record. Every number comes from
 * digest fields — nothing invented.
 */
export function pickContradiction(digest: NightDigest): Contradiction | undefined {
  const dodgeCounts = new Map<string, number>();
  for (const dodge of digest.dodges ?? []) {
    if (typeof dodge.alias !== "string") continue;
    const key = normAlias(dodge.alias);
    dodgeCounts.set(key, (dodgeCounts.get(key) ?? 0) + 1);
  }
  const topDodger = digest.stats?.topDodger;

  const candidates = (digest.selfVsRoom ?? [])
    .map((row) => ({
      row,
      count: dodgeCounts.get(normAlias(row.alias)) ?? 0,
    }))
    .filter(({ row, count }) => {
      const self = numeric(row.self);
      const roomMean = numeric(row.roomMean);
      return count >= 1 && self >= 8 && self - roomMean >= 2;
    })
    .sort(
      (a, b) =>
        b.count - a.count ||
        (numeric(b.row.self) - numeric(b.row.roomMean)) -
          (numeric(a.row.self) - numeric(a.row.roomMean)) ||
        naturalCompare(a.row.alias, b.row.alias),
    );

  const best = candidates[0];
  if (best) {
    return {
      trait: best.row.trait,
      self: numeric(best.row.self),
      roomMean: numeric(best.row.roomMean),
      dodges: best.count,
      who: best.row.alias,
    };
  }
  if (topDodger && numeric(topDodger.count) >= 2) {
    const row = (digest.selfVsRoom ?? []).find(
      (entry) => normAlias(entry.alias) === normAlias(topDodger.alias),
    );
    if (row) {
      return {
        trait: row.trait,
        self: numeric(row.self),
        roomMean: numeric(row.roomMean),
        dodges: numeric(topDodger.count),
        who: row.alias,
      };
    }
  }
  return undefined;
}

function digestSource(input: {
  who?: string;
  texts: string[];
  numbers?: Record<string, number>;
  verbatim?: string;
}): SkeletonSource {
  const { who, texts, numbers, verbatim } = input;
  return {
    subjects: who ? [who] : [],
    players: new Set([...(who ? [who] : []), ...playerTokensIn(texts)]),
    numbers: new Set([...numberStrings(numbers), ...digitsIn(texts)]),
    material: texts.join(" "),
    ...(verbatim ? { verbatim } : {}),
  };
}

// --------------------------------------------------------------------------
// buildSkeleton
// --------------------------------------------------------------------------

export function buildSkeleton(
  results: Results,
  digest: NightDigest,
  rosterInput?: RosterInput,
): FinaleSlide[] {
  const ps = derivePseudonyms(results, digest, rosterInput);
  const slides: FinaleSlide[] = [];

  const push = (draft: SlideDraft, source: SkeletonSource): FinaleSlide => {
    const slide = materialize(draft);
    SOURCES.set(slide, source);
    slides.push(slide);
    return slide;
  };

  const emptySource = (): SkeletonSource => ({
    subjects: [],
    players: new Set(),
    numbers: new Set(),
    material: "",
  });

  const claims = (results.claims ?? []).filter(isPublishable);
  const ofType = (type: ClaimType): Claim[] => claims.filter((claim) => claim.type === type);

  // 1 ── title ────────────────────────────────────────────────────────────
  push(
    {
      beat: "tease",
      title: "THE ROOM HAS SPOKEN",
      body: "Every answer you gave tonight, played back. No context, no mercy.",
    },
    emptySource(),
  );

  // 2 ── besties: tease → escalate → land ─────────────────────────────────
  const besties = rankClaims(ofType("besties"), (claim) => pairScoreOf(claim, results))[0];
  if (besties) {
    const source = sourceForClaim(besties, ps);
    const beats = sectionBodies(
      besties,
      "A friendship in this room comes with receipts. Brace.",
    );
    push(
      {
        beat: "tease",
        flavor: "claim",
        claimId: besties.id,
        title: "SOMETHING'S BEEN BUILDING",
        body: beats.tease,
      },
      source,
    );
    push(
      {
        beat: "escalate",
        flavor: "claim",
        claimId: besties.id,
        title: "THE FRIENDSHIP RECEIPTS",
        body: beats.escalate,
        numbers: besties.numbers,
      },
      source,
    );
    push(
      {
        beat: "land",
        flavor: "claim",
        claimId: besties.id,
        title: "BESTIES",
        body: beats.land,
        numbers: besties.numbers,
      },
      source,
    );
  }

  // 3 ── rivals ───────────────────────────────────────────────────────────
  const rival = rankClaims(ofType("rival"), (claim) => pairScoreOf(claim, results))[0];
  if (rival) {
    const { evidenceBody, fallback } = claimBodies(rival);
    push(
      {
        beat: "escalate",
        flavor: "claim",
        claimId: rival.id,
        title: "RIVALS",
        body: evidenceBody ?? fallback,
        numbers: rival.numbers,
      },
      sourceForClaim(rival, ps),
    );
  }

  // 4 ── consensus claims → Group Announcements ──────────────────────────
  const consensus = rankClaims(
    ofType("consensus"),
    (claim) => numeric(claim.numbers?.share),
  ).slice(0, NARRATOR_TUNING.maxConsensusSlides);
  for (const claim of consensus) {
    const { evidenceBody, fallback } = claimBodies(claim);
    push(
      {
        beat: "land",
        flavor: "group",
        claimId: claim.id,
        title: "THE ROOM AGREES",
        body: evidenceBody ?? fallback,
        numbers: claim.numbers, // copied untouched: votes/of/share drive the animation
      },
      sourceForClaim(claim, ps),
    );
  }

  // 5 ── blind spots ──────────────────────────────────────────────────────
  const gapOf = (claim: Claim): number => {
    const numbers = claim.numbers ?? {};
    if (numbers.spread !== undefined) return Math.abs(numeric(numbers.spread));
    if (numbers.gap !== undefined) return Math.abs(numeric(numbers.gap));
    const self = numbers.self;
    const mean = numbers.groupMean ?? numbers.roomMean;
    if (self !== undefined && mean !== undefined) return Math.abs(numeric(self) - numeric(mean));
    return 0;
  };
  const blindspots = rankClaims(ofType("blindspot"), gapOf).slice(
    0,
    NARRATOR_TUNING.maxBlindspotSlides,
  );
  for (const claim of blindspots) {
    const { evidenceBody, fallback } = claimBodies(claim);
    push(
      {
        beat: "escalate",
        flavor: "claim",
        claimId: claim.id,
        title: "BLIND SPOT",
        body: evidenceBody ?? fallback,
        numbers: claim.numbers,
      },
      sourceForClaim(claim, ps),
    );
  }

  // 6 ── digest comedy block ─────────────────────────────────────────────

  // QUOTE OF THE NIGHT — verbatim, attributed when we have an honest mapping.
  const quote = pickQuote(digest);
  if (quote) {
    const text = quote.text.trim();
    const who = pseudonymForAlias(ps, quote.alias);
    const body = withAttribution(`"${text}"`, who, NARRATOR_TUNING.bodyMaxChars);
    push(
      {
        beat: "tease",
        flavor: "quote",
        title: "QUOTE OF THE NIGHT",
        body,
      },
      digestSource({
        who,
        texts: [text, quote.context ?? ""],
        verbatim: text,
      }),
    );
  }

  // DODGE REPORT — every excuse, verbatim.
  const dodges = (digest.dodges ?? [])
    .filter((dodge) => typeof dodge.reason === "string" && dodge.reason.trim().length > 0)
    .slice(0, NARRATOR_TUNING.maxDodgeSlides);
  for (const dodge of dodges) {
    const line = dodgeLine(dodge.alias, dodge.reason, ps);
    push(
      {
        beat: "escalate",
        flavor: "dodge",
        title: line.title,
        body: line.body,
      },
      digestSource({
        who: line.who,
        texts: [line.reason],
        verbatim: line.reason,
      }),
    );
  }

  // SPEED RUNNER — fastest finger of the night.
  const fastest = digest.stats?.fastest;
  if (fastest && Number.isFinite(fastest.ms) && fastest.ms > 0) {
    const who = pseudonymForAlias(ps, fastest.alias);
    const ms = fastest.ms;
    const body = who
      ? `${who} locked it in in ${ms}ms. No thoughts, just thumbs.`
      : `Someone locked it in in ${ms}ms. No thoughts, just thumbs.`;
    push(
      {
        beat: "escalate",
        flavor: "stat",
        title: "SPEED RUNNER",
        body,
        numbers: { ms },
      },
      digestSource({ who, texts: [body], numbers: { ms } }),
    );
  }

  // CONTRADICTION WATCH — derived from digest stats + self-vs-room gaps.
  const contradiction = pickContradiction(digest);
  if (contradiction) {
    const who = pseudonymForAlias(ps, contradiction.who);
    const room = Math.round(contradiction.roomMean * 10) / 10;
    const bodyWho = who ?? "Someone in this room";
    const body = `${bodyWho} gave their own ${contradiction.trait} a ${contradiction.self}. The room gives a ${room}. The excuses keep coming.`;
    push(
      {
        beat: "escalate",
        flavor: "stat",
        title: "CONTRADICTION WATCH",
        body,
        numbers: {
          self: contradiction.self,
          roomMean: contradiction.roomMean,
          dodges: contradiction.dodges,
        },
      },
      digestSource({
        who,
        texts: [body],
        numbers: {
          self: contradiction.self,
          roomMean: contradiction.roomMean,
          dodges: contradiction.dodges,
        },
      }),
    );
  }

  // 7 ── toxic: the room-verdict land beat ────────────────────────────────
  const toxic = rankClaims(ofType("toxic"), (claim) => {
    const numbers = claim.numbers ?? {};
    return (
      numeric(numbers.percentile) ||
      numeric(numbers.negIndegreePct) ||
      numeric(numbers.share)
    );
  })[0];
  if (toxic) {
    const { evidenceBody, fallback } = claimBodies(toxic);
    push(
      {
        beat: "land",
        flavor: "group",
        claimId: toxic.id,
        title: "MOST TOXIC",
        body: evidenceBody ?? fallback,
        numbers: toxic.numbers,
      },
      sourceForClaim(toxic, ps),
    );
  }

  // 8 ── SHIP: the biggest beat ───────────────────────────────────────────
  const ship = rankClaims(ofType("ship"), (claim) => pairScoreOf(claim, results))[0];
  if (ship) {
    const source = sourceForClaim(ship, ps);
    const beats = sectionBodies(
      ship,
      "One pair came out of this night with the highest pair score. Brace.",
    );
    push(
      {
        beat: "tease",
        flavor: "claim",
        claimId: ship.id,
        title: "PUT YOUR GLASSES DOWN",
        body: beats.tease,
      },
      source,
    );
    push(
      {
        beat: "escalate",
        flavor: "claim",
        claimId: ship.id,
        title: "THE SIGNS WERE THERE",
        body: beats.escalate,
        numbers: ship.numbers,
      },
      source,
    );
    push(
      {
        beat: "land",
        flavor: "claim",
        claimId: ship.id,
        title: "SHIPPED",
        body: beats.land,
        numbers: ship.numbers,
      },
      source,
    );
  }

  // 9 ── free agent (odd n) — own slide, spec §5 ──────────────────────────
  if (results.freeAgent) {
    const who = pseudonymOf(ps, results.freeAgent);
    const body = who
      ? `Nobody locked in on ${who} tonight. Free agent status: confirmed.`
      : "One player walked out unmatched. Free agent status: confirmed.";
    push(
      { beat: "tease", title: "FREE AGENT", body },
      {
        subjects: who ? [who] : [],
        players: new Set(who ? [who] : []),
        numbers: new Set(),
        material: body,
      },
    );
  }

  // 10 ── closing ─────────────────────────────────────────────────────────
  push(
    {
      beat: "land",
      title: "THAT'S THE NIGHT",
      body: "Screens down. You know too much about each other now. Use it kindly.",
    },
    emptySource(),
  );

  return slides;
}

// --------------------------------------------------------------------------
// helpers shared with write.ts
// --------------------------------------------------------------------------

/**
 * Never-empty, never-overflowing title. Engine titles already respect the
 * 6-word rule; this only catches a malformed caller (or a hand-built slide).
 */
export function normalizeTitle(title: string | undefined, index: number): string {
  const trimmed =
    typeof title === "string" ? title.trim().replace(/\s+/g, " ") : "";
  if (trimmed.length === 0) {
    return index === 0 ? "THE ROOM HAS SPOKEN" : "THE VERDICT";
  }
  const words = trimmed.split(" ").filter((word) => word.length > 0);
  const capped = words.slice(0, NARRATOR_TUNING.titleMaxWords).join(" ");
  return clip(capped, LIMITS.titleMaxChars);
}

/**
 * Best-effort source for a slide the module did not build (e.g. the caller
 * cloned the skeleton with `{...slide}` before narrating). Conservative on
 * purpose: the model may only repeat digits that are already in the engine
 * text or in the slide's own numbers.
 */
export function conservativeSource(
  slide: FinaleSlide,
  results: Results,
  ps: Pseudonyms,
): SkeletonSource {
  const claim = slide.claimId
    ? (results.claims ?? []).find((candidate) => candidate.id === slide.claimId)
    : undefined;
  const evidence = claim?.evidence ?? [];
  const texts = [slide.title, slide.body ?? "", ...evidence];
  const subjects = (claim?.subjects ?? [])
    .map((id) => pseudonymOf(ps, id))
    .filter((token): token is string => Boolean(token));
  return {
    ...(slide.claimId ? { claimId: slide.claimId } : {}),
    ...(claim ? { claimType: claim.type } : {}),
    subjects,
    players: new Set([...subjects, ...playerTokensIn(texts)]),
    numbers: new Set([
      ...Object.values(slide.numbers ?? {}).map((value) => String(value)),
      ...digitsIn(texts),
    ]),
    material: evidence.join(" "),
  };
}

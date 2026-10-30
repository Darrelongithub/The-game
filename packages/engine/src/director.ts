// packages/engine/src/director.ts
// ROUND 4 — THE DIRECTOR. Pure, deterministic, zero I/O.
//
// The engine forms private SUSPICIONS about the room ("hypotheses"), then uses
// them to choose which ordinary prompt comes next. A hypothesis is a direction
// hint, never content: it is never serialized, never logged client-side, never
// hinted at in an interlude, never recapped at the finale. Players only ever
// feel the effect — rounds that keep landing on something relevant.
//
// Rules that keep it honest:
//  - every number here is deterministic (no Math.random, no Date.now: `now` is
//    derived from the log itself, and selection is seeded by the round index);
//  - a suspicion only lives in the MID-BAND (HYPOTHESIS_FORM_BAND) — strong
//    enough to probe, weak enough to stay a suspicion;
//  - above the band with ≥3 independent signals a suspicion GRADUATES into an
//    ordinary Claim and leaves the set (the finale pays it off like any claim);
//  - one-sided material NEVER becomes public: it graduates only as a private
//    claim (a finale Secret Card on the picker's phone) or not at all;
//  - the selector never touches the same subject pair more than
//    ANTI_TELEGRAPH_MAX rounds in a row. That cap is what keeps the game from
//    machine-gunning two people and getting clocked.
import {
  ANTI_TELEGRAPH_MAX,
  CONFIDENCE_RULES,
  HYPOTHESIS_FORM_BAND,
  ROUND_MIX,
  type Claim,
  type Hypothesis,
  type HypothesisKind,
  type LogRecord,
  type PairSignal,
  type PlayerId,
  type Prompt,
  type PromptCoding,
  type RoomMeta,
} from "../../shared/src/contracts.ts";
import {
  ENGINE_TUNING,
  NEGATIVE_CODINGS,
  POSITIVE_CODINGS,
  clamp01,
  confidenceFromCount,
  directedPicks,
  formatNumber,
  getPicks,
  meanOf,
  pairKey,
  playerIdsSorted,
  pseudoOf,
} from "./internal.ts";
import { mulberry32 } from "./rng.ts";

// ---------------------------------------------------------------------------
// Dimensions & coverage matrix
// ---------------------------------------------------------------------------

/** A prompt's dimension = its coding. The matrix is pair × dimension. */
export type Dimension = PromptCoding;
export const DIMENSIONS: readonly Dimension[] = [
  "couple", "friendship", "trust", "friction", "rivalry", "status", "neutral",
] as const;

/** Which dimension a hypothesis wants probed. */
export const HYPOTHESIS_DIMENSION: Readonly<Record<HypothesisKind, Dimension>> = {
  tension: "friction",
  besties: "friendship",
  secret: "trust",
  selfimage: "status",
  onesided: "couple",
  freeagent: "neutral",
};

/** `pairKey|dimension → rounds that touched it`. Plain data, server-private. */
export type Coverage = Record<string, number>;

export interface DirectorState {
  coverage: Coverage;
  /** pair keys of recent selections, oldest first (anti-telegraph memory) */
  recentPairs: string[];
  /** prompt ids already used tonight */
  usedIds: string[];
}

export const emptyDirectorState = (usedIds: readonly string[] = []): DirectorState => ({
  coverage: {},
  recentPairs: [],
  usedIds: [...usedIds],
});

/** One key for "these subjects together" — a solo subject is its own pair. */
export const subjectPairKey = (subjects: readonly PlayerId[]): string => {
  const unique = [...new Set(subjects)].sort();
  if (unique.length <= 1) return unique[0] ?? "";
  return unique.slice(0, 2).join("\u0000");
};

export const coverageKey = (subjects: readonly PlayerId[], dimension: Dimension): string =>
  `${subjectPairKey(subjects)}|${dimension}`;

export const coverageCount = (state: DirectorState, subjects: readonly PlayerId[], dimension: Dimension): number =>
  state.coverage[coverageKey(subjects, dimension)] ?? 0;

/** Trailing run length of `pair` in the touch history — the anti-telegraph read. */
export const consecutiveTouches = (recentPairs: readonly string[], pair: string): number => {
  let count = 0;
  for (let i = recentPairs.length - 1; i >= 0; i--) {
    if (recentPairs[i] !== pair) break;
    count++;
  }
  return count;
};

/** Record a selected round: bump its cell and append to the touch history. */
export const recordSelection = (
  state: DirectorState,
  input: { subjects: readonly PlayerId[]; dimension: Dimension; promptId: string },
): DirectorState => {
  const key = coverageKey(input.subjects, input.dimension);
  return {
    coverage: { ...state.coverage, [key]: (state.coverage[key] ?? 0) + 1 },
    recentPairs: [...state.recentPairs, subjectPairKey(input.subjects)].slice(-16),
    usedIds: state.usedIds.includes(input.promptId) ? state.usedIds : [...state.usedIds, input.promptId],
  };
};

export interface CoverageCell { pair: string; dimension: Dimension; count: number; }

/**
 * Every (pair × dimension) cell, least-covered first. Deterministic order:
 * count, then pair key, then dimension order.
 */
export function coverageCells(state: DirectorState, meta: RoomMeta): CoverageCell[] {
  const ids = playerIdsSorted(meta);
  const cells: CoverageCell[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      for (const dimension of DIMENSIONS) {
        const key = `${pairKey(ids[i]!, ids[j]!)}|${dimension}`;
        cells.push({ pair: pairKey(ids[i]!, ids[j]!), dimension, count: state.coverage[key] ?? 0 });
      }
    }
  }
  return cells.sort((x, y) =>
    x.count - y.count ||
    (x.pair < y.pair ? -1 : x.pair > y.pair ? 1 : 0) ||
    DIMENSIONS.indexOf(x.dimension) - DIMENSIONS.indexOf(y.dimension));
}

export const starvedCells = (state: DirectorState, meta: RoomMeta): CoverageCell[] =>
  coverageCells(state, meta).filter((cell) => cell.count === 0);

// ---------------------------------------------------------------------------
// Selection — the 50 / 30 / 20 mix
// ---------------------------------------------------------------------------

export type DirectedMode = "test" | "explore" | "classic";

export interface DirectedRound {
  prompt: Prompt;
  mode: DirectedMode;
  /** ordered subjects to bind into {P1},{P2},… (empty for a classic round) */
  subjects: PlayerId[];
  dimension: Dimension;
  hypothesisId?: string;
  /** state AFTER recording this selection */
  state: DirectorState;
}

export interface PlanInput {
  hypotheses: readonly Hypothesis[];
  state: DirectorState;
  candidates: readonly Prompt[];
  /** deterministic seed — the round index in production */
  seed: number;
  /** the round kind the phase slot requires, when it has one */
  kind?: Prompt["kind"];
  meta?: RoomMeta;
}

const placeholders = (text: string): number => (text.match(/\{P(?:1[01]|[1-9])\}/gu) ?? []).length;
/** Only OPEN (mid-band) suspicions are worth probing: "supported" is already
 *  strong enough that asking again would telegraph the interest. */
const probeable = (h: Hypothesis): boolean => h.status === "open";

/** Deterministic split of the mix. `ROUND_MIX` is config: retune by replay. */
export function pickMode(seed: number): DirectedMode {
  const draw = mulberry32(seed >>> 0)();
  if (draw < ROUND_MIX.test) return "test";
  if (draw < ROUND_MIX.test + ROUND_MIX.explore) return "explore";
  return "classic";
}

/** Only the choices that preserve the kind slot the phase asked for. */
const candidatesFor = (input: PlanInput): Prompt[] => {
  const used = new Set(input.state.usedIds);
  const fresh = input.candidates.filter((p) => !used.has(p.id));
  const kindOk = fresh.filter((p) => (input.kind ? p.kind === input.kind : true));
  return kindOk.length > 0 ? kindOk : fresh;
};

const antiTelegraphOk = (state: DirectorState, subjects: readonly PlayerId[]): boolean => {
  const pair = subjectPairKey(subjects);
  if (!pair) return true;
  return consecutiveTouches(state.recentPairs, pair) < ANTI_TELEGRAPH_MAX;
};

/** TEST: probe the strongest open suspicion on its own dimension. */
function testChoice(input: PlanInput, pool: Prompt[]) {
  const ranked = [...input.hypotheses]
    .filter(probeable)
    .filter((h) => h.subjects.length > 0)
    .filter((h) => antiTelegraphOk(input.state, h.subjects))
    .sort((a, b) => b.strength - a.strength || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const hypothesis of ranked) {
    const dimension = HYPOTHESIS_DIMENSION[hypothesis.kind];
    // A targeted prompt must read as organic: an ordinary prompt that happens
    // to be about these people. Never a prompt that only makes sense because
    // the game suspects something.
    const matching = pool.filter((p) => p.coding === dimension && placeholders(p.text) > 0);
    if (matching.length === 0) continue;
    return { prompt: matching[0]!, subjects: hypothesis.subjects.slice(0, 2), dimension, hypothesisId: hypothesis.id };
  }
  return undefined;
}

/** EXPLORE: the least-covered cell the room can still reach. */
function exploreChoice(input: PlanInput, pool: Prompt[]) {
  const meta = input.meta;
  if (!meta) return undefined;
  const byDimension = new Map<Dimension, Prompt[]>();
  for (const prompt of pool) {
    const arr = byDimension.get(prompt.coding);
    if (arr) arr.push(prompt);
    else byDimension.set(prompt.coding, [prompt]);
  }
  for (const cell of coverageCells(input.state, meta)) {
    if (cell.count > 0) break; // remaining cells are covered already
    const prompts = byDimension.get(cell.dimension);
    if (!prompts || prompts.length === 0) continue;
    const subjects = cell.pair.split("\u0000");
    if (!antiTelegraphOk(input.state, subjects)) continue;
    return { prompt: prompts[0]!, subjects, dimension: cell.dimension };
  }
  return undefined;
}

/** CLASSIC: an ordinary round, no subject binding, no suspicion behind it. */
function classicChoice(input: PlanInput, pool: Prompt[]) {
  if (pool.length === 0) return undefined;
  const index = Math.floor(mulberry32((input.seed >>> 0) ^ 0x9e3779b9)() * pool.length) % pool.length;
  return { prompt: pool[index]! };
}

/**
 * Plan one round. The mix is honoured whenever the pool can honour it: a test
 * slot with nothing to test falls through to explore, a fully-covered matrix
 * falls through to classic. That fallthrough is why a small bank never starves
 * a category.
 */
export function planRound(input: PlanInput): DirectedRound | undefined {
  const pool = candidatesFor(input);
  if (pool.length === 0) return undefined;
  const mode = pickMode(input.seed);
  const finish = (
    choice: { prompt: Prompt; subjects: PlayerId[]; dimension: Dimension; hypothesisId?: string },
    chosen: DirectedMode,
  ): DirectedRound => ({
    prompt: choice.prompt, mode: chosen, subjects: [...choice.subjects], dimension: choice.dimension,
    ...(choice.hypothesisId ? { hypothesisId: choice.hypothesisId } : {}),
    state: recordSelection(input.state, { subjects: choice.subjects, dimension: choice.dimension, promptId: choice.prompt.id }),
  });
  const order: DirectedMode[] = mode === "test" ? ["test", "explore", "classic"]
    : mode === "explore" ? ["explore", "test", "classic"] : ["classic", "explore", "test"];
  for (const step of order) {
    if (step === "test") {
      const choice = testChoice(input, pool);
      if (choice) return finish(choice, "test");
    } else if (step === "explore") {
      const choice = exploreChoice(input, pool);
      if (choice) return finish(choice, "explore");
    } else {
      const choice = classicChoice(input, pool);
      if (choice) return finish({ prompt: choice.prompt, subjects: [], dimension: choice.prompt.coding }, "classic");
    }
  }
  return undefined;
}

/**
 * The contract-signature selector: (hypotheses, coverage, candidates, seed) →
 * the next Prompt. `coverage` may be a bare matrix or the full state.
 */
export function directNextRound(
  hypotheses: readonly Hypothesis[],
  coverage: Coverage | DirectorState,
  candidates: readonly Prompt[],
  seed: number,
  options: { kind?: Prompt["kind"]; meta?: RoomMeta; recentPairs?: readonly string[]; usedIds?: readonly string[] } = {},
): Prompt {
  const state: DirectorState = "recentPairs" in coverage && "usedIds" in coverage
    ? (coverage as DirectorState)
    : { coverage: coverage as Coverage, recentPairs: [...(options.recentPairs ?? [])], usedIds: [...(options.usedIds ?? [])] };
  const planned = planRound({
    hypotheses, state, candidates, seed,
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.meta ? { meta: options.meta } : {}),
  });
  if (!planned) throw new Error("director: no candidate prompt to direct");
  return planned.prompt;
}

// ---------------------------------------------------------------------------
// Hypotheses — mid-band suspicions, formed after every round
// ---------------------------------------------------------------------------

export interface HypothesisUpdate {
  /** the live, still-suspicious set (graduated and noise-only ones are absent) */
  hypotheses: Hypothesis[];
  /** deterministic claims a suspicion just GRADUATED into (ordinary claims) */
  claims: Claim[];
}

export interface HypothesisOptions {
  /** round id the update follows — stamped on the hypotheses it probed */
  lastRoundId?: string;
  /** hypothesis the selector just tested, if any */
  testedHypothesisId?: string;
}

const band = HYPOTHESIS_FORM_BAND;
export const inBand = (strength: number): boolean => strength >= band.lo && strength <= band.hi;
export const aboveBand = (strength: number): boolean => strength > band.hi;

const latestAt = (log: readonly LogRecord[], select: (r: LogRecord) => boolean = () => true): number => {
  let at = 0;
  for (const rec of log) if (select(rec) && rec.at > at) at = rec.at;
  return at;
};

// ---------- deterministic per-suspicion readers ----------

/** self rating minus the room's mean, per trait (the blind-spot gap). */
function selfGaps(log: readonly LogRecord[], player: PlayerId): Record<string, number> {
  const out: Record<string, number> = {};
  for (const rec of log) {
    if (rec.value.kind !== "rating" || rec.value.about !== "self" || rec.playerId !== player) continue;
    const trait = rec.value.trait;
    const peers = log.flatMap((r) => r.value.kind === "rating" && r.value.about === player && r.value.trait === trait && r.playerId !== player ? [r.value.value] : []);
    if (peers.length === 0) continue;
    const gap = rec.value.value - meanOf(peers);
    if (Math.abs(gap) > Math.abs(out[trait] ?? 0)) out[trait] = gap;
  }
  return out;
}

function latestSelfRating(log: readonly LogRecord[], player: PlayerId, trait: string): number | undefined {
  let value: number | undefined;
  for (const rec of log) {
    if (rec.playerId !== player || rec.value.kind !== "rating" || rec.value.about !== "self" || rec.value.trait !== trait) continue;
    value = rec.value.value;
  }
  return value;
}

const count = (values: readonly boolean[]): number => values.filter(Boolean).length;

interface Suspicion {
  kind: HypothesisKind;
  subjects: PlayerId[];
  strength: number;
  evidence: string[];
  independentSignals: number;
  /** earliest supporting log timestamp — the deterministic openedAt */
  since: number;
}

/** Everything the engine is currently suspicious about, as raw suspects. */
function suspicions(signals: readonly PairSignal[], log: readonly LogRecord[], meta: RoomMeta): Suspicion[] {
  const out: Suspicion[] = [];
  const picks = getPicks(log);
  const lastAt = latestAt(log);

  for (const s of signals) {
    const [a, b] = [s.a, s.b];
    const between = picks.filter((p) => (p.picker === a && p.target === b) || (p.picker === b && p.target === a));
    const negativeBetween = between.filter((p) => NEGATIVE_CODINGS.has(p.coding));
    const positiveBetween = between.filter((p) => POSITIVE_CODINGS.has(p.coding));
    const pairPseudo = `${pseudoOf(meta, a)} and ${pseudoOf(meta, b)}`;

    // tension — friction between two people, no ship in sight.
    const tension = clamp01(0.5 * s.negativeMutual + 0.5 * (1 - s.pairScore));
    if (tension >= band.lo - 0.2 && negativeBetween.length > 0 && s.negativeMutual > 0) {
      out.push({
        kind: "tension", subjects: [a, b], strength: tension,
        evidence: [
          `${negativeBetween.length} friction pick${negativeBetween.length === 1 ? "" : "s"} between ${pairPseudo}.`,
          ...(s.iosMean > 0 ? [`Closeness reads ${formatNumber(Math.round(s.iosMean * 7))}/7.`] : []),
          ...(s.negativeMutual > 0 ? [`Negative picks are mutual ${Math.round(s.negativeMutual * 100)}% of the time.`] : []),
        ],
        independentSignals: count([
          s.negativeMutual >= 0.15,
          negativeBetween.length > 0,
          s.pairScore <= ENGINE_TUNING.rivalPairScoreMid.max,
          s.pickOverlap <= 0.25,
        ]),
        since: latestAt(log, (r) => r.value.kind === "pick" && NEGATIVE_CODINGS.has(r.coding) && ((r.playerId === a && r.value.target === b) || (r.playerId === b && r.value.target === a))),
      });
    }

    // besties — the friend lane, mutual.
    const besties = clamp01(0.5 * s.friendEvidence + 0.3 * s.iosMean + 0.2 * s.pairScore);
    if (besties >= band.lo - 0.2 && (s.friendEvidence > 0 || s.iosMean > 0.5)) {
      out.push({
        kind: "besties", subjects: [a, b], strength: besties,
        evidence: [
          ...(positiveBetween.length > 0 ? [`${positiveBetween.length} friendly pick${positiveBetween.length === 1 ? "" : "s"} between ${pairPseudo}.`] : []),
          ...(s.iosMean > 0 ? [`Closeness ${formatNumber(Math.round(s.iosMean * 7))}/7 both ways.`] : []),
          ...(s.debriefSim !== 0.5 ? [`Their private debriefs overlapped ${Math.round(s.debriefSim * 100)}%.`] : []),
        ],
        independentSignals: count([s.friendEvidence >= 0.5, s.iosMean >= 0.5, s.traitAgreement >= 0.7, positiveBetween.length > 0]),
        since: latestAt(log, (r) => r.value.kind === "pick" && POSITIVE_CODINGS.has(r.coding) && ((r.playerId === a && r.value.target === b) || (r.playerId === b && r.value.target === a))),
      });
    }

    // onesided — INTERNAL ONLY. It may graduate as a PRIVATE claim (one phone),
    // never as anything the room can see.
    const forward = directedPicks(picks, a, b, (c) => POSITIVE_CODINGS.has(c));
    const reverse = directedPicks(picks, b, a, (c) => POSITIVE_CODINGS.has(c));
    if (forward.hits >= 2) {
      const oneSided = clamp01(forward.rate * (1 - reverse.rate));
      if (oneSided >= 0.2) {
        out.push({
          kind: "onesided", subjects: [a, b], strength: oneSided,
          evidence: [
            `${pseudoOf(meta, a)} chose ${pseudoOf(meta, b)} ${forward.hits} time${forward.hits === 1 ? "" : "s"}; the other way happened ${reverse.hits} time${reverse.hits === 1 ? "" : "s"}.`,
          ],
          independentSignals: count([forward.rate >= 0.5, reverse.rate <= 0.25, forward.hits >= 2]),
          since: latestAt(log, (r) => r.value.kind === "pick" && r.playerId === a && r.value.target === b && POSITIVE_CODINGS.has(r.coding)),
        });
      }
    }
  }

  // selfimage — one person's self-view drifts from the room's.
  for (const player of meta.players) {
    const gaps = Object.entries(selfGaps(log, player.id));
    if (gaps.length === 0) continue;
    const biggest = [...gaps].sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]) || (x[0] < y[0] ? -1 : 1))[0]!;
    const strength = clamp01(Math.abs(biggest[1]) / 9);
    const meaningful = gaps.filter(([, gap]) => Math.abs(gap) >= ENGINE_TUNING.blindspotMinGap).length;
    out.push({
      kind: "selfimage", subjects: [player.id], strength,
      evidence: [`${pseudoOf(meta, player.id)} rates their ${biggest[0]} ${formatNumber(Math.abs(biggest[1]))} points ${biggest[1] > 0 ? "higher" : "lower"} than the room does.`],
      independentSignals: count([meaningful >= 1, meaningful >= 2, gaps.length >= 2]),
      since: lastAt,
    });
  }

  // secret — dodging while claiming to be an open book.
  for (const player of meta.players) {
    const passes = log.filter((r) => r.playerId === player.id && r.value.kind === "dare" && r.value.status === "passed").length;
    if (passes === 0) continue;
    const honesty = latestSelfRating(log, player.id, "honesty");
    if (honesty === undefined) continue;
    const dareRounds = new Set(log.filter((r) => r.playerId === player.id && r.value.kind === "dare").map((r) => r.roundId)).size;
    const dodgeShare = dareRounds === 0 ? 0 : passes / dareRounds;
    const strength = clamp01((honesty / 10) * (0.5 + 0.5 * dodgeShare));
    out.push({
      kind: "secret", subjects: [player.id], strength,
      evidence: [`${pseudoOf(meta, player.id)} rates honesty ${honesty}/10 and has taken the out ${passes} time${passes === 1 ? "" : "s"}.`],
      independentSignals: count([passes >= 1, honesty >= 7, dodgeShare >= 0.4]),
      since: latestAt(log, (r) => r.playerId === player.id && r.value.kind === "dare" && r.value.status === "passed"),
    });
  }

  // freeagent — someone with no reciprocal positive signal at all.
  for (const player of meta.players) {
    const around = signals.filter((s) => s.a === player.id || s.b === player.id);
    if (around.length === 0) continue;
    const best = Math.max(...around.map((s) => Math.max(s.friendEvidence, s.mutualPick, s.iosMean)));
    const strength = clamp01(1 - best);
    out.push({
      kind: "freeagent", subjects: [player.id], strength,
      evidence: [`${pseudoOf(meta, player.id)} has no reciprocal positive pick yet.`],
      independentSignals: count([
        around.every((s) => s.mutualPick < 0.25),
        around.every((s) => s.iosMean < 0.35),
        around.every((s) => s.pickOverlap < 0.35),
      ]),
      since: lastAt,
    });
  }
  return out;
}

/** Claim types a suspicion may graduate into. One-sided is private, always. */
const GRADUATES_TO: Partial<Record<HypothesisKind, Claim["type"]>> = {
  tension: "rival",
  besties: "besties",
  selfimage: "blindspot",
  onesided: "onesided",
};

const suspicionKey = (kind: HypothesisKind, subjects: readonly PlayerId[]): string =>
  `${kind}:${subjectPairKey(subjects)}`;

/** Human-readable, stable id — the key is a map key, never a rendered string. */
const hypothesisId = (kind: HypothesisKind, subjects: readonly PlayerId[]): string =>
  `${kind}-${subjectPairKey(subjects).replace("\u0000", "-")}`;

/**
 * Strength measured on everything BEFORE the newest round, so a suspicion that
 * was in the band and has since fallen out can be REFUTED (rather than simply
 * vanishing). Pair components are reused as-is — only the round-scoped counts
 * differ — which keeps this cheap and deterministic.
 */
const suspicionsBeforeLastRound = (
  signals: readonly PairSignal[], log: readonly LogRecord[], meta: RoomMeta,
): Map<string, Suspicion> => {
  const roundIds = [...new Set(log.map((r) => r.roundId))];
  const map = new Map<string, Suspicion>();
  if (roundIds.length < 2) return map;
  const lastRoundId = roundIds[roundIds.length - 1];
  const previous = log.filter((r) => r.roundId !== lastRoundId);
  if (previous.length === 0) return map;
  for (const suspicion of suspicions([...signals], previous, meta)) {
    map.set(suspicionKey(suspicion.kind, suspicion.subjects), suspicion);
  }
  return map;
};

/**
 * updateHypotheses — runs after EVERY round. Returns the live set plus any
 * claims a suspicion just graduated into (the server merges those as ordinary
 * claims; it never sees a "board", and neither does a player).
 *
 * `priors` are last night's unresolved suspicions, already re-mapped onto
 * tonight's player ids by the server. They keep their original `openedAt`, so
 * the engine quietly keeps interrogating old suspects. Guests pass none.
 */
export function updateHypotheses(
  signals: readonly PairSignal[],
  log: readonly LogRecord[],
  meta: RoomMeta,
  priors: readonly Hypothesis[] = [],
  options: HypothesisOptions = {},
): HypothesisUpdate {
  const before = suspicionsBeforeLastRound(signals, log, meta);
  const fresh = new Map<string, Suspicion>();
  for (const suspicion of suspicions(signals, log, meta)) fresh.set(suspicionKey(suspicion.kind, suspicion.subjects), suspicion);
  const claims: Claim[] = [];
  const graduated = new Set<string>();
  const live = new Map<string, Hypothesis>();

  const tested = (id: string): boolean => options.testedHypothesisId === id && !!options.lastRoundId;

  const toHypothesis = (suspicion: Suspicion, status: Hypothesis["status"], since: number, extra?: string): Hypothesis => ({
    id: hypothesisId(suspicion.kind, suspicion.subjects),
    kind: suspicion.kind,
    subjects: [...suspicion.subjects],
    status,
    strength: suspicion.strength,
    evidence: [...suspicion.evidence, ...(extra ? [extra] : [])],
    openedAt: since,
    ...(options.lastRoundId ? { lastTestedRound: options.lastRoundId } : {}),
  });

  // 1. Carried priors survive even before tonight's first supporting answer:
  //    the question is still open, so keep asking.
  for (const prior of priors) {
    const key = suspicionKey(prior.kind, prior.subjects);
    if (fresh.has(key)) continue;
    if (prior.status === "refuted") continue;
    live.set(key, {
      id: prior.id, kind: prior.kind, subjects: [...prior.subjects], status: "open",
      strength: prior.strength, evidence: [...prior.evidence], openedAt: prior.openedAt,
      ...(prior.lastTestedRound ? { lastTestedRound: prior.lastTestedRound } : {}),
    });
  }

  // 2. Tonight's suspicions: mid-band opens/updates, above-band graduates or
  //    holds, below-band is noise (or a refutation of something that was in).
  for (const [key, suspicion] of fresh) {
    const id = hypothesisId(suspicion.kind, suspicion.subjects);
    const prior = priors.find((p) => suspicionKey(p.kind, p.subjects) === key);
    const openedAt = prior?.openedAt ?? (suspicion.since > 0 ? suspicion.since : latestAt(log));
    const previousStrength = before.get(key)?.strength ?? prior?.strength;

    if (!inBand(suspicion.strength) && !aboveBand(suspicion.strength)) {
      if (previousStrength !== undefined && previousStrength >= band.lo) {
        live.set(key, toHypothesis(suspicion, "refuted", openedAt, "The latest round pulled the other way."));
      }
      continue;
    }

    // ABOVE THE BAND with ≥3 independent signals (CONFIDENCE_RULES.high) →
    // graduate to an ordinary claim and LEAVE the hypothesis set. Graduation
    // needs a defensible claim type: secret and freeagent never graduate.
    const target = GRADUATES_TO[suspicion.kind];
    const confidence = confidenceFromCount(suspicion.independentSignals);
    if (aboveBand(suspicion.strength) && target && confidence === "high" && suspicion.independentSignals >= CONFIDENCE_RULES.high.independentSignals) {
      claims.push({
        id: `dir-${suspicion.kind}-${suspicion.subjects.join("-")}`,
        type: target,
        subjects: [...suspicion.subjects],
        // HARD RULE: one-sided material never becomes public, ever.
        audience: suspicion.kind === "onesided" ? "private" : "public",
        confidence,
        evidence: suspicion.evidence.slice(0, 4),
        numbers: { strength: Number(suspicion.strength.toFixed(3)), signals: suspicion.independentSignals },
      });
      live.delete(key);
      graduated.add(key);
      continue;
    }

    const status: Hypothesis["status"] = aboveBand(suspicion.strength) ? "supported" : "open";
    const hypothesis = toHypothesis(suspicion, status, openedAt);
    const lastTestedRound = tested(id) ? options.lastRoundId : prior?.lastTestedRound;
    if (lastTestedRound) hypothesis.lastTestedRound = lastTestedRound;
    live.set(key, hypothesis);
  }

  // 3. REFUTATION. A suspicion that WAS in the band before the newest round
  //    and is no longer even a suspicion (fresh evidence pulled the other way)
  //    stays visible to the engine as "refuted" — never as a player-facing
  //    trace, because players see no hypotheses at all.
  for (const [key, previous] of before) {
    if (live.has(key) || graduated.has(key)) continue;
    if (previous.strength < band.lo) continue;
    const now = fresh.get(key);
    const prior = priors.find((p) => suspicionKey(p.kind, p.subjects) === key);
    live.set(key, {
      id: hypothesisId(previous.kind, previous.subjects),
      kind: previous.kind,
      subjects: [...previous.subjects],
      status: "refuted",
      strength: now?.strength ?? 0,
      evidence: [...(now ?? previous).evidence, "The latest round pulled the other way."],
      openedAt: prior?.openedAt ?? (previous.since > 0 ? previous.since : latestAt(log)),
      ...(options.lastRoundId ? { lastTestedRound: options.lastRoundId } : {}),
    });
  }

  const hypotheses = [...live.values()].sort((a, b) => b.strength - a.strength || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { hypotheses, claims };
}

/** Contract-signature convenience: hypotheses only (spec STEP 3). */
export function formHypotheses(
  signals: readonly PairSignal[],
  log: readonly LogRecord[],
  meta: RoomMeta,
  priors: readonly Hypothesis[] = [],
): Hypothesis[] {
  return updateHypotheses(signals, log, meta, priors).hypotheses;
}

/**
 * End of night: whatever is still an open question becomes UNRESOLVED so it can
 * ride into the next night as a prior (accounts only). Guests simply drop it.
 */
export function carryOver(hypotheses: readonly Hypothesis[]): Hypothesis[] {
  return hypotheses
    .filter((h) => h.status !== "refuted")
    .map((h) => ({
      ...h,
      status: h.status === "open" || h.status === "supported" ? "unresolved" : h.status,
      evidence: [...h.evidence],
    }));
}

/** ROUND 4 regression seam: throw if a payload carries internal hints. */
export function assertNoHypothesisLeak(payload: unknown): void {
  const seen = new Set<unknown>();
  const walk = (value: unknown, path: string): void => {
    if (typeof value !== "object" || value === null) return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { value.forEach((item, i) => walk(item, `${path}[${i}]`)); return; }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/^(hypothes[ie]s?|suspects?|case_?board|priors?|coverage|director)$/iu.test(key)) {
        throw new Error(`director leak: "${path}.${key}" carries internal hypothesis material`);
      }
      walk(child, `${path}.${key}`);
    }
  };
  walk(payload, "$");
}

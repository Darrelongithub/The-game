// apps/server/src/game.ts
// THE CASE ENGINE + THE ROOM MANAGER.
//
// v3.2 shape of a night:
//   lobby → generating → play → results → closed
//
// The unit of play is a CASE about ONE subject. While that case is open the
// room is split into three groups at the same time:
//   • OBSERVER PAIRS — the other players, split into pairs. Each pair gets a
//     DIFFERENT question about the subject (or about another pair).
//   • THE SUBJECT — gets a real question of their own. Never a decoy.
//   • THE LEFTOVER — when the observer count is odd, the extra player gets a
//     solo spicy prompt instead.
//
// Next case: the subject changes and the pairings reshuffle round-robin.
//
// TIMING. A case closes the INSTANT the last required person answers. The
// per-kind timer is only a CAP; a player who runs out of time is skipped and
// the game keeps moving. After a case closes there is a 1–2s "locked in" beat
// and then the next case. There is NO per-round ready gate and NO per-round
// reveal — one gate at the very end, then the host laptop reveals.
import {
  AGE_MIN,
  BEAT_HOLD_MS,
  CASES_PER_NIGHT,
  DARE_CASES,
  MAX_PLAYERS,
  MIN_PLAYERS,
  READY_GATE_GRACE_MS,
  ROUND_TIMERS_MS,
  SHIP_VOTE_CASES,
  type Band,
  type LogRecord,
  type PlayerId,
  type ProfileAnswers,
  type Prompt,
  type PromptRole,
  type ResponseValue,
  type RoomCode,
  type RoomView,
  type RoundKind,
  type RoundView,
  type TraitId,
} from "../../../packages/shared/src/contracts.ts";
import { validSubmit } from "../../../packages/shared/src/validate.ts";
import {
  LOOK_STAGE_ACT,
  LOOK_STAGE_GUESS,
  LOOK_STAGE_WHY,
  type LookChainVariant,
} from "./lookchain.ts";
import { integratedServices } from "./integratedServices.ts";
import type { GameServices, PromptProvider } from "./services.ts";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export interface Player {
  id: PlayerId;
  alias: string;
  /** Secret used to reclaim a seat after a disconnect. */
  secret: string;
  connected: boolean;
  isBot: boolean;
  /** Profile answers — ENGINE ONLY. Never sent to any client, never logged. */
  profile?: ProfileAnswers;
  /** Lobby ready tick. */
  ready: boolean;
  /** The single end-of-night ready gate. */
  finalReady: boolean;
  joinedAt: number;
}

/** One question shown to one group of players inside a case. */
export interface Segment {
  id: string;
  /** Who answers this segment. */
  players: PlayerId[];
  /** The bank prompt (already substituted with real aliases). */
  prompt: Prompt;
  kind: RoundKind;
  /** The text shown on the phone — real names, one question. */
  text: string;
  /** The small grey line under the question. */
  note: string;
  /** The case subject, when this segment is about them. */
  subjectId?: PlayerId;
  /** The pair this segment is about, for pair questions. */
  pair?: [PlayerId, PlayerId];
  /** Options for a pair_pick segment. */
  options?: { id: string; members: [PlayerId, PlayerId]; label: string }[];
  /** The named player a dare is aimed at. */
  target?: PlayerId;
  /** Trait for a rating segment. */
  trait?: TraitId;
  /** Whether the rating is about yourself. */
  aboutSelf?: boolean;
  /** Epoch ms when this segment's cap runs out. */
  closesAt: number;
  /** Who has answered. */
  answered: Set<PlayerId>;
  /** Whether this segment was skipped (everyone timed out). */
  skipped: boolean;
  /**
   * Which stage of the case this segment belongs to (0-based). A look chain
   * runs three stages; an ordinary case has exactly one.
   */
  stage?: number;
  /** True when the answer stays hidden until the reveal. */
  hidden?: boolean;
}

export interface Case {
  id: string;
  index: number;
  subjectId?: PlayerId;
  segments: Segment[];
  /** Everyone who must answer for this case to close. */
  required: Set<PlayerId>;
  startedAt: number;
  closed: boolean;
  /** How many stages this case runs (an ordinary case runs one). */
  stageCount?: number;
  /** The stage that is open right now (0-based). */
  stage?: number;
  /**
   * The copy a WATCHING phone shows, per stage. A look chain has people who
   * are not answering at a given stage — they see this instead of a question.
   */
  passiveCopy?: { text: string; note: string }[];
  /** The public one-liner for this case ("Everybody look at X."). */
  headline?: string;
}

export interface Room {
  code: RoomCode;
  /** The host token — bound at startup, no code typing on the laptop. */
  hostToken: string;
  createdAt: number;
  phase: RoomView["phase"];
  players: Map<PlayerId, Player>;
  /** Join order — Player 1 is the first player who joined. */
  order: PlayerId[];
  hostConnected: boolean;
  /** The night seed — the same seed gives the same shuffle. */
  seed: number;
  /** The cases for tonight. */
  cases: Case[];
  caseIndex: number;
  current?: Case;
  log: LogRecord[];
  /** Prompt ids already used tonight — no template repeats. */
  usedPromptIds: Set<string>;
  /** Prompts available for the night (bank + anything Ollama wrote). */
  pool: Prompt[];
  /** Players who said "Ready for the results". */
  finalReady: Set<PlayerId>;
  /** The reveal has been shown. */
  revealed: boolean;
  /** Total cases tonight. */
  totalCases: number;
  /** Generation progress for the loading screen. */
  generation?: { done: number; total: number };
  /** The pairs already used for ship votes — no pair twice. */
  shipPairsUsed: Set<string>;
  /** Look chains played tonight. */
  lookChains: { actor: PlayerId; target: PlayerId; reason?: string; guessed: PlayerId[] }[];
  seq: number;
  /** Set when the room is deleted. */
  deleted: boolean;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export const roomCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function makeRoomCode(rand: () => number = Math.random): string {
  let out = "";
  for (let i = 0; i < 4; i++) out += roomCodeAlphabet[Math.floor(rand() * roomCodeAlphabet.length)];
  return out;
}

export function makeToken(rand: () => number = Math.random): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 24; i++) out += chars[Math.floor(rand() * chars.length)];
  return out;
}

/** "About Wanjiru. They won't see this." */
export function noteFor(subjectAlias: string | undefined, pairAliases?: [string, string]): string {
  if (pairAliases) return `About ${pairAliases[0]} and ${pairAliases[1]}. They won't see this.`;
  if (subjectAlias) return `About ${subjectAlias}. They won't see this.`;
  return "About the room. Everyone sees this.";
}

/**
 * Substitute {P1}..{Pn} with real aliases.
 * `binding` maps the placeholder index (1-based) to the alias for that slot.
 */
export function substitute(text: string, binding: Map<number, string>): string {
  return text.replace(/\{P(\d{1,2})\}/g, (match, raw: string) => {
    const index = Number(raw);
    const alias = binding.get(index);
    return alias ?? match;
  });
}

/** The observers of a case — everyone but the subject. */
export function observersFor(order: readonly PlayerId[], subjectId: PlayerId): PlayerId[] {
  return order.filter((id) => id !== subjectId);
}

/**
 * A placeholder binding for a set of aliases: {P1} → first alias, {P2} →
 * second, and so on. A phone never shows a raw "{P1}".
 */
export function bindingFor(aliases: readonly string[]): Map<number, string> {
  const binding = new Map<number, string>();
  aliases.forEach((alias, index) => binding.set(index + 1, alias));
  return binding;
}

/** Cut a list into pairs; the odd one out is the leftover. */
export function pairUp(observers: readonly PlayerId[], rotation: number): { pairs: PlayerId[][]; leftover?: PlayerId } {
  const rotated = [...observers];
  if (rotated.length > 1) {
    const shift = rotation % rotated.length;
    rotated.push(...rotated.splice(0, shift));
  }
  const pairs: PlayerId[][] = [];
  for (let i = 0; i + 1 < rotated.length; i += 2) pairs.push([rotated[i]!, rotated[i + 1]!]);
  const leftover = rotated.length % 2 === 1 ? rotated[rotated.length - 1] : undefined;
  return { pairs, leftover };
}

/** Every unordered pair of players. */
export function allPairs(ids: readonly PlayerId[]): [PlayerId, PlayerId][] {
  const out: [PlayerId, PlayerId][] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) out.push([ids[i]!, ids[j]!]);
  }
  return out;
}

/** A stable key for a pair. */
export const pairKey = (a: PlayerId, b: PlayerId): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** The trait a rating prompt asks about, if any. */
export function traitOf(prompt: Prompt): TraitId | undefined {
  for (const m of prompt.measures) {
    if (m.startsWith("trait:")) return m.slice("trait:".length) as TraitId;
  }
  return undefined;
}

/**
 * The answer kind a segment accepts. A "longtext" question is answered with a
 * text answer; everything else answers with its own kind.
 */
export function answerKindFor(kind: RoundKind): ResponseValue["kind"] {
  return kind === "longtext" ? "text" : kind;
}

/** The metric a prompt measures, if any. */
export function metricOf(prompt: Prompt): string | undefined {
  for (const m of prompt.measures) {
    if (m.startsWith("metric:")) return m.slice("metric:".length);
  }
  return undefined;
}

/**
 * The 18+ gate. Age comes from the sign-up profile; consent must be given.
 * This is asserted in code — not just checked in the UI.
 */
export function assertAdult(profile: ProfileAnswers | undefined, consentAge: boolean): void {
  if (!profile) throw new Error("sign-up requires a profile");
  if (!Number.isInteger(profile.age) || profile.age < AGE_MIN) {
    throw new Error(`sign-up requires age ${AGE_MIN}+`);
  }
  if (!consentAge) throw new Error("sign-up requires the 18+ consent tick");
}

// ---------------------------------------------------------------------------
// the case builder
// ---------------------------------------------------------------------------

export interface DrawFn {
  (role: PromptRole, count: number, opts?: { kinds?: readonly RoundKind[]; metric?: string }): Prompt[];
}

export interface BuildCaseInput {
  room: Room;
  index: number;
  draw: DrawFn;
  aliasOf: (id: PlayerId) => string;
  now: number;
}

/**
 * Build one case: a subject, their own question, and a different question for
 * every observer pair.
 */
export function buildCase(input: BuildCaseInput): Case {
  const { room, index, draw, aliasOf, now } = input;
  const players = room.order;
  const subjectId = players[index % players.length]!;
  const observers = observersFor(players, subjectId);
  const { pairs, leftover } = pairUp(observers, index);

  const segments: Segment[] = [];
  const required = new Set<PlayerId>();

  // Aliases of everyone except the subject. Used to fill any placeholder a
  // subject/solo prompt might carry, so a phone never shows a raw "{P1}".
  const otherAliases = observers.map((id) => aliasOf(id));

  /**
   * A tiny queue over the provider. When a role runs dry it asks again, so a
   * pair is never left without a question.
   */
  const makeQueue = (role: PromptRole, size: number) => {
    let items: Prompt[] = [];
    let refills = 0;
    return (): Prompt | undefined => {
      if (items.length === 0 && refills < 4) {
        items = draw(role, size);
        refills += 1;
      }
      return items.shift();
    };
  };

  // ---- the subject's own real question ----
  const nextSubject = makeQueue("subject", 1);
  const subjectPrompt = nextSubject();
  if (subjectPrompt) {
    segments.push({
      id: `${room.code}-c${index}-subject`,
      players: [subjectId],
      prompt: subjectPrompt,
      kind: subjectPrompt.kind,
      text: substitute(subjectPrompt.text, bindingFor(otherAliases)),
      note: "Your answer stays between you and the results.",
      subjectId,
      trait: traitOf(subjectPrompt),
      aboutSelf: true,
      closesAt: now + ROUND_TIMERS_MS[subjectPrompt.kind],
      answered: new Set(),
      skipped: false,
    });
    required.add(subjectId);
  }

  // ---- one DIFFERENT question per observer pair ----
  const pairCount = pairs.length;
  const nextObserver = makeQueue("observer_subject", pairCount);
  const nextPairPrompt = makeQueue("observer_pair", 1);
  for (let i = 0; i < pairCount; i++) {
    const pair = pairs[i]!;
    // Alternate between "about the subject" and "about another pair" so the
    // room sees both shapes. Each pair still gets its own question.
    const preferPair = pairCount > 1 && i % 2 === 1;
    let prompt = preferPair ? nextPairPrompt() : nextObserver();
    if (!prompt) prompt = nextObserver();
    if (!prompt) prompt = nextPairPrompt();
    if (!prompt) continue;

    // A prompt about ANOTHER pair gets the other pair's names. A prompt about
    // the subject gets the subject's name. The prompt's own role decides.
    const aboutPair = prompt.role === "observer_pair" && pairCount > 1;
    let text: string;
    let note: string;
    let pairRef: [PlayerId, PlayerId] | undefined;
    if (aboutPair) {
      const otherPair = pairs[(i + 1) % pairCount]!;
      const binding = new Map<number, string>([
        [1, aliasOf(otherPair[0]!)],
        [2, aliasOf(otherPair[1]!)],
      ]);
      text = substitute(prompt.text, binding);
      note = noteFor(undefined, [aliasOf(otherPair[0]!), aliasOf(otherPair[1]!)]);
      pairRef = [otherPair[0]!, otherPair[1]!];
    } else {
      const binding = bindingFor([aliasOf(subjectId), ...otherAliases]);
      text = substitute(prompt.text, binding);
      note = noteFor(aliasOf(subjectId));
    }

    segments.push({
      id: `${room.code}-c${index}-p${i}`,
      players: pair,
      prompt,
      kind: prompt.kind,
      text,
      note,
      subjectId,
      pair: pairRef,
      trait: traitOf(prompt),
      closesAt: now + ROUND_TIMERS_MS[prompt.kind],
      answered: new Set(),
      skipped: false,
    });
    for (const p of pair) required.add(p);
  }

  // ---- the odd one out gets a solo spicy prompt ----
  if (leftover) {
    const nextSolo = makeQueue("solo", 1);
    const soloPrompt = nextSolo();
    if (soloPrompt) {
      segments.push({
        id: `${room.code}-c${index}-solo`,
        players: [leftover],
        prompt: soloPrompt,
        kind: soloPrompt.kind,
        text: substitute(soloPrompt.text, bindingFor([aliasOf(subjectId), ...otherAliases])),
        note: "Just for you. Nobody else sees this.",
        closesAt: now + ROUND_TIMERS_MS[soloPrompt.kind],
        answered: new Set(),
        skipped: false,
      });
      required.add(leftover);
    }
  }

  return {
    id: `${room.code}-c${index}`,
    index,
    subjectId,
    segments,
    required,
    startedAt: now,
    closed: false,
  };
}

/**
 * Build a ship-vote case: the app picks a RANDOM pair, everyone else votes
 * yes/no (1–5) on whether they would make a good couple. No pair twice.
 */
export function buildShipVoteCase(input: {
  room: Room;
  index: number;
  aliasOf: (id: PlayerId) => string;
  now: number;
  rand: () => number;
}): Case | undefined {
  const { room, index, aliasOf, now, rand } = input;
  const candidates = allPairs(room.order).filter(([a, b]) => !room.shipPairsUsed.has(pairKey(a, b)));
  if (candidates.length === 0) return undefined;
  const [a, b] = candidates[Math.floor(rand() * candidates.length)]!;
  room.shipPairsUsed.add(pairKey(a, b));

  const voters = room.order.filter((id) => id !== a && id !== b);
  const prompt: Prompt = {
    id: `${room.code}-ship-${index}`,
    source: "bank",
    band: "spicy",
    role: "group",
    kind: "pair_vote",
    text: `Would ${aliasOf(a)} and ${aliasOf(b)} make a good couple?`,
    measures: ["metric:couple-fit"],
    coding: "couple",
    asksTarget: true,
  };
  const segment: Segment = {
    id: `${room.code}-c${index}-ship`,
    players: voters,
    prompt,
    kind: "pair_vote",
    text: prompt.text,
    note: `About ${aliasOf(a)} and ${aliasOf(b)}. They won't see this.`,
    pair: [a, b],
    closesAt: now + ROUND_TIMERS_MS.pair_vote,
    answered: new Set(),
    skipped: false,
  };
  return {
    id: `${room.code}-c${index}`,
    index,
    segments: [segment],
    required: new Set(voters),
    startedAt: now,
    closed: false,
  };
}

/**
 * Build a "who would make the best couple here" case — everybody picks a
 * pair from the list.
 *
 * A player never sees a pair they are in: shipping yourself is not an option,
 * so the server refuses those answers anyway. The public view filters the
 * list per player.
 */
export function buildBestCoupleCase(input: {
  room: Room;
  index: number;
  aliasOf: (id: PlayerId) => string;
  now: number;
  rand: () => number;
}): Case | undefined {
  const { room, index, aliasOf, now, rand } = input;
  if (room.order.length < 2) return undefined;
  const pairs = allPairs(room.order);
  // A shortlist of candidate couples, in a different order every night.
  const shuffled = [...pairs];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const options = shuffled.slice(0, Math.min(6, shuffled.length)).map(([a, b]) => ({
    id: pairKey(a, b),
    members: [a, b] as [PlayerId, PlayerId],
    label: `${aliasOf(a)} & ${aliasOf(b)}`,
  }));
  if (options.length === 0) return undefined;
  const prompt: Prompt = {
    id: `${room.code}-bestcouple-${index}`,
    source: "bank",
    band: "spicy",
    role: "group",
    kind: "pair_pick",
    text: "Who do you think would make the best couple here?",
    measures: ["metric:couple-fit"],
    coding: "couple",
    asksTarget: true,
  };
  const segment: Segment = {
    id: `${room.code}-c${index}-bestcouple`,
    players: [...room.order],
    prompt,
    kind: "pair_pick",
    text: prompt.text,
    note: "About the room. Only the results will show.",
    options,
    closesAt: now + ROUND_TIMERS_MS.pair_pick,
    answered: new Set(),
    skipped: false,
  };
  return {
    id: `${room.code}-c${index}`,
    index,
    segments: [segment],
    required: new Set(room.order),
    startedAt: now,
    closed: false,
  };
}

/**
 * Build a dare case: a named player is given a dare. They can do it, or say
 * "I can't" and give a reason (the reason is data).
 */
/**
 * Build a LOOK CHAIN — the four-step live moment.
 *
 *   stage 1 (ACT)   the actor alone: "Look at someone you love." A hidden
 *                   tap. The room only sees "Everybody look at X."
 *   stage 2 (GUESS) everybody else: "Who is X looking at?" Also hidden.
 *   stage 3 (WHY)   the actor again: one line, why.
 *
 * Nothing about the chain reaches anybody until the reveal. The truth lives
 * in the log and comes out as the actor's private card and a finale slide.
 */
export function buildLookChainCase(input: {
  room: Room;
  index: number;
  aliasOf: (id: PlayerId) => string;
  now: number;
  rand: () => number;
  variant: LookChainVariant;
  /** Players who have already acted in a chain tonight. */
  acted?: ReadonlySet<PlayerId>;
}): Case | undefined {
  const { room, index, aliasOf, now, rand, variant, acted } = input;
  if (room.order.length < 2) return undefined;
  // Everybody gets a turn before anybody gets a second one.
  const fresh = room.order.filter((id) => !acted?.has(id));
  const pool = fresh.length > 0 ? fresh : room.order;
  const actor = pool[Math.floor(rand() * pool.length)]!;
  const actorAlias = aliasOf(actor);
  const guessers = room.order.filter((id) => id !== actor);
  if (guessers.length === 0) return undefined;

  const id = `${room.code}-c${index}-chain`;
  const announce = variant.announce.replace(/\{A\}/g, actorAlias);
  const guess = variant.guess.replace(/\{A\}/g, actorAlias);

  const actSegment: Segment = {
    id: `${id}-act`,
    players: [actor],
    prompt: {
      id: `${id}-act-prompt`,
      source: "bank",
      band: "spicy",
      role: "subject",
      kind: "pick",
      text: variant.act,
      measures: ["metric:lookchain"],
      coding: "couple",
      asksTarget: true,
    },
    kind: "pick",
    text: variant.act,
    note: "Nobody sees this. It comes out at the end.",
    subjectId: actor,
    closesAt: now + ROUND_TIMERS_MS.pick,
    answered: new Set(),
    skipped: false,
    stage: 0,
    hidden: true,
  };

  const guessSegment: Segment = {
    id: `${id}-guess`,
    players: guessers,
    prompt: {
      id: `${id}-guess-prompt`,
      source: "bank",
      band: "spicy",
      role: "group",
      kind: "pick",
      text: guess,
      measures: ["metric:lookchain-guess"],
      coding: "couple",
      asksTarget: true,
    },
    kind: "pick",
    text: guess,
    note: "Guess it. The truth comes out at the end.",
    subjectId: actor,
    closesAt: now + ROUND_TIMERS_MS.pick,
    answered: new Set(),
    skipped: false,
    stage: 1,
    hidden: true,
  };

  const whySegment: Segment = {
    id: `${id}-why`,
    players: [actor],
    prompt: {
      id: `${id}-why-prompt`,
      source: "bank",
      band: "spicy",
      role: "subject",
      kind: "text",
      text: variant.why,
      measures: ["metric:lookchain"],
      coding: "couple",
      asksTarget: false,
    },
    kind: "text",
    text: variant.why,
    note: "One line. It comes out at the end.",
    subjectId: actor,
    closesAt: now + ROUND_TIMERS_MS.text,
    answered: new Set(),
    skipped: false,
    stage: 2,
    hidden: true,
  };

  return {
    id,
    index,
    subjectId: actor,
    segments: [actSegment, guessSegment, whySegment],
    required: new Set(room.order),
    startedAt: now,
    closed: false,
    stageCount: 3,
    stage: 0,
    headline: announce,
    passiveCopy: [
      { text: announce, note: `${actorAlias} is looking at someone. You will not see who.` },
      { text: "They are guessing who you are looking at.", note: "Say nothing. Not a word." },
      { text: `${actorAlias} is about to say why.`, note: "One line, then it is over." },
    ],
  };
}

export function buildDareCase(input: {
  room: Room;
  index: number;
  aliasOf: (id: PlayerId) => string;
  now: number;
  rand: () => number;
  prompt: Prompt;
}): Case | undefined {
  const { room, index, aliasOf, now, rand, prompt } = input;
  if (room.order.length === 0) return undefined;
  const target = room.order[Math.floor(rand() * room.order.length)]!;
  const segment: Segment = {
    id: `${room.code}-c${index}-dare`,
    players: [target],
    prompt,
    kind: "dare",
    text: substitute(prompt.text, new Map([[1, aliasOf(target)]])),
    note: "Everyone is watching.",
    target,
    closesAt: now + ROUND_TIMERS_MS.dare,
    answered: new Set(),
    skipped: false,
  };
  return {
    id: `${room.code}-c${index}`,
    index,
    subjectId: target,
    segments: [segment],
    required: new Set([target]),
    startedAt: now,
    closed: false,
  };
}

/** The number of cases tonight. */
export function totalCasesFor(playerCount: number): number {
  if (playerCount <= MIN_PLAYERS) return CASES_PER_NIGHT - 2;
  if (playerCount >= MAX_PLAYERS) return CASES_PER_NIGHT;
  return CASES_PER_NIGHT - 1;
}

/** How many ship-vote cases tonight. */
export const shipVotesFor = (playerCount: number): number =>
  Math.max(1, Math.min(SHIP_VOTE_CASES, playerCount - 2));

/** How many dare cases tonight. */
export const daresFor = (playerCount: number): number => Math.max(1, Math.min(DARE_CASES, playerCount - 3));

/** How many look chains tonight (six, or up to eight in a big room). */
export { lookChainsFor } from "./lookchain.ts";
export { LOOK_STAGE_ACT, LOOK_STAGE_GUESS, LOOK_STAGE_WHY } from "./lookchain.ts";

/** The band order a night uses — spicy first, then warmup, deep, dare. */
export const NIGHT_BANDS: readonly Band[] = ["spicy", "warmup", "deep", "dare"];

/** How long the ready gate waits before the host can force it. */
export const READY_GATE_MS = READY_GATE_GRACE_MS;

/** The beat between cases. */
export const BEAT_MS = BEAT_HOLD_MS;

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

/** The public view of a case for ONE player. */
export function caseViewFor(room: Room, playerId: PlayerId, now: number): RoundView | null {
  const current = room.current;
  if (!current) return null;
  const stage = current.stage ?? 0;
  const segment = current.segments.find((s) => (s.stage ?? 0) === stage && s.players.includes(playerId));
  const staged = (current.stageCount ?? 1) > 1;

  if (!segment) {
    // This phone is only WATCHING this stage (a look chain).
    const copy = current.passiveCopy?.[stage];
    if (!copy) return null;
    return {
      roundId: current.id,
      segmentId: `${current.id}-watch-${stage}`,
      index: current.index + 1,
      kind: "text",
      promptText: copy.text,
      note: copy.note,
      closesAt: now + ROUND_TIMERS_MS.text,
      youSubmitted: true,
      passive: true,
      chainActor: current.subjectId,
      stage: staged ? stage + 1 : undefined,
      subjectId: current.subjectId,
      submitted: [],
    };
  }

  return {
    roundId: current.id,
    segmentId: segment.id,
    index: current.index + 1,
    kind: segment.kind,
    promptText: segment.text,
    note: segment.note,
    closesAt: segment.closesAt,
    youSubmitted: segment.answered.has(playerId),
    pair: segment.pair,
    // A player never sees a couple they are part of.
    options: segment.options?.filter((option) => !option.members.includes(playerId)),
    target: segment.target,
    trait: segment.trait,
    aboutSelf: segment.aboutSelf,
    subjectId: segment.subjectId,
    submitted: [...segment.answered],
    stage: staged ? stage + 1 : undefined,
    chainActor: staged ? current.subjectId : undefined,
    hidden: segment.hidden,
  };
}

/** The public view of the room. Nothing private leaves here. */
export function roomView(room: Room, now: number): RoomView {
  const players = room.order
    .map((id) => room.players.get(id))
    .filter((p): p is Player => Boolean(p))
    .map((p) => ({
      id: p.id,
      alias: p.alias,
      connected: p.connected,
      isBot: p.isBot,
      ready: p.ready,
    }));
  const view: RoomView = {
    code: room.code,
    phase: room.phase,
    players,
    round: null,
    seq: room.seq,
    hostPresent: room.hostConnected,
    lobbyReady: room.order.filter((id) => room.players.get(id)?.ready),
    progress: { index: room.caseIndex, total: room.totalCases },
  };
  if (room.phase === "results") view.ready = [...room.finalReady];
  if (room.generation) view.generation = room.generation;
  if (room.phase === "play" && room.current?.headline) view.headline = room.current.headline;
  return view;
}

/** The public view of the room for ONE player (their own case segment). */
export function roomViewFor(room: Room, playerId: PlayerId, now: number): RoomView {
  const view = roomView(room, now);
  // Your own pick list never contains you.
  view.pickOptions = room.order.filter((id) => id !== playerId);
  if (room.phase === "play") view.round = caseViewFor(room, playerId, now);
  return view;
}

/** Record an answer in the log. */
export function logAnswer(
  room: Room,
  playerId: PlayerId,
  segment: Segment,
  value: ResponseValue,
  now: number,
  latencyMs: number,
): LogRecord {
  const record: LogRecord = {
    roomId: room.code,
    roundId: room.current?.id ?? segment.id,
    playerId,
    roundKind: segment.kind,
    promptId: segment.prompt.id,
    coding: segment.prompt.coding,
    value,
    at: now,
    latencyMs,
    segmentId: segment.id,
    band: segment.prompt.band,
    metric: metricOf(segment.prompt) as LogRecord["metric"],
    subjectId: segment.subjectId,
  };
  room.log.push(record);
  return record;
}

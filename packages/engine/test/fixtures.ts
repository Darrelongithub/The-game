// packages/engine/test/fixtures.ts
// Test helpers: a room, a log, and the small builders the tests use.
import type {
  LogRecord,
  PlayerId,
  PromptCoding,
  ResponseValue,
  RoomMeta,
} from "../../shared/src/contracts.ts";

export const meta: RoomMeta = {
  roomId: "TEST",
  players: [
    { id: "p1", alias: "Wanjiru" },
    { id: "p2", alias: "Dee" },
    { id: "p3", alias: "Kofi" },
    { id: "p4", alias: "Zuri" },
    { id: "p5", alias: "Tayo" },
  ],
};

export const ids: PlayerId[] = meta.players.map((p) => p.id);

let seq = 0;

/** A log record with sensible defaults. */
export function rec(
  playerId: PlayerId,
  value: ResponseValue,
  opts: {
    metric?: string;
    coding?: PromptCoding;
    roundId?: string;
    promptId?: string;
    latencyMs?: number;
    subjectId?: PlayerId;
    roundKind?: LogRecord["roundKind"];
  } = {},
): LogRecord {
  seq += 1;
  return {
    roomId: meta.roomId,
    roundId: opts.roundId ?? `r${seq}`,
    playerId,
    roundKind: opts.roundKind ?? (value.kind === "pair_vote" ? "pair_vote" : value.kind === "pair_pick" ? "pair_pick" : value.kind === "rating" ? "rating" : value.kind === "dare" ? "dare" : value.kind === "text" ? "text" : "pick"),
    promptId: opts.promptId ?? `q${seq}`,
    coding: opts.coding ?? "neutral",
    value,
    at: 1_700_000_000_000 + seq,
    latencyMs: opts.latencyMs ?? 1_000,
    ...(opts.metric ? { metric: opts.metric as LogRecord["metric"] } : {}),
    ...(opts.subjectId ? { subjectId: opts.subjectId } : {}),
  };
}

/** A pick of `target` by `picker`. */
export const pick = (picker: PlayerId, target: PlayerId, metric?: string, coding?: PromptCoding): LogRecord =>
  rec(picker, { kind: "pick", target }, { ...(metric ? { metric } : {}), ...(coding ? { coding } : {}) });

/** A self-rating. */
export const selfRate = (player: PlayerId, trait: string, value: number): LogRecord =>
  rec(player, { kind: "rating", trait: trait as never, about: "self", value });

/** A rating of somebody else. */
export const peerRate = (player: PlayerId, about: PlayerId, trait: string, value: number): LogRecord =>
  rec(player, { kind: "rating", trait: trait as never, about, value });

/** A yes/no vote on a pair. */
export const vote = (voter: PlayerId, a: PlayerId, b: PlayerId, value: number, metric?: string): LogRecord =>
  rec(voter, { kind: "pair_vote", pair: [a, b], value }, { ...(metric ? { metric } : {}) });

/** A pair pick. */
export const pairPick = (voter: PlayerId, a: PlayerId, b: PlayerId, metric?: string): LogRecord =>
  rec(voter, { kind: "pair_pick", pair: [a, b] }, { ...(metric ? { metric } : {}) });

/** A written answer. */
export const text = (player: PlayerId, body: string): LogRecord =>
  rec(player, { kind: "text", text: body });

/** A look chain: the actor's hidden choice. */
export const look = (actor: PlayerId, target: PlayerId, roundId: string): LogRecord =>
  rec(actor, { kind: "pick", target }, { metric: "lookchain", roundId });

/** Somebody's guess at who the actor is looking at. */
export const lookGuess = (guesser: PlayerId, target: PlayerId, roundId: string): LogRecord =>
  rec(guesser, { kind: "pick", target }, { metric: "lookchain-guess", roundId });

/** The actor's reason for the look. */
export const lookWhy = (actor: PlayerId, body: string, roundId: string): LogRecord =>
  rec(actor, { kind: "text", text: body }, { metric: "lookchain", roundId });

// src/lib/transport.ts — the ONE seam between the UI and the game server.
//
// Two implementations behind NEXT_PUBLIC_TRANSPORT:
//   "socket" (DEFAULT) — the shipped build talks to the real same-origin server.
//   "mock"             — an in-memory scripted night, for developing screens
//                        with no server running.
//
// The UI only ever sees this interface, the frozen contracts, and nothing else.
//
// v3.2 shape: the room is created AT STARTUP on the server. A phone joins with
// the four-character code that rides in the QR; the laptop binds to tonight's
// room with a token and never holds a player seat.
import type {
  BeatView,
  FinaleView,
  JoinReply,
  JoinRequest,
  ResponseValue,
  RoomCode,
  RoomView,
  RoundView,
  SecretDeckView,
  SubmitRequest,
} from "@shared/contracts.ts";

export interface TransportHandlers {
  /** full snapshot — server authoritative, always replaces local state */
  onState?: (view: RoomView) => void;
  /** ONE question, for this phone only */
  onRound?: (view: RoundView) => void;
  /** the 1–2s "locked in" beat between cases */
  onBeat?: (beat: BeatView) => void;
  /** broadcast-safe public slides only — identical on every laptop */
  onFinale?: (view: FinaleView) => void;
  /** PRIVATE — this phone only, never broadcast */
  onSecrets?: (deck: SecretDeckView) => void;
  onDeleted?: () => void;
  onError?: (e: { code: string; message: string }) => void;
  /** transport-level connection state (drives the connection-lost overlay) */
  onConnection?: (connected: boolean, info?: { resuming?: boolean }) => void;
}

export interface Transport {
  readonly mode: "socket" | "mock";
  setHandlers(handlers: TransportHandlers): void;
  /** A phone joins tonight's room with the code from the QR. */
  join(req: JoinRequest): Promise<JoinReply>;
  /** The laptop binds to tonight's room with its token — no code to type. */
  hostJoin(token: string): Promise<{ ok: boolean; error?: string }>;
  submit(req: SubmitRequest): Promise<{ ok: boolean; error?: string }>;
  /** The lobby tick: "I'm in". */
  lobbyReady(ready: boolean): void;
  /** "Ready for the results" — the ONE ready gate, at the end of the night. */
  ready(): void;
  /** host laptop only */
  start(): void;
  forceResults(): void;
  addBot(): void;
  skipRound(): void;
  /** anyone */
  deleteRoom(): void;
  /** re-join with the stored secret (+ full snapshot). */
  resume(): void;
  /** Forget the tab's seat and detach its socket without deleting the room. */
  forgetSession(): void;
  disconnect(): void;
}

export const DEFAULT_ROOM_CODE_EMPTY: RoomCode = "";

export function transportMode(): "socket" | "mock" {
  return process.env.NEXT_PUBLIC_TRANSPORT === "mock" ? "mock" : "socket";
}

export async function createTransport(handlers: TransportHandlers = {}): Promise<Transport> {
  // The large scripted mock is a development-only chunk, never part of the
  // socket build's initial download. Both modes remain available offline.
  const t: Transport = transportMode() === "mock"
    ? new (await import("./mockTransport")).MockTransport()
    : new (await import("./socketTransport")).SocketTransport();
  t.setHandlers(handlers);
  return t;
}

/** A short, stable id for a submit (the server ignores it, the log keeps it). */
export function makeClientUuid(): string {
  const c = globalThis.crypto;
  if (c && "randomUUID" in c) return c.randomUUID();
  return `u-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export type { ResponseValue, SubmitRequest };
export type { Transport as TransportApi };

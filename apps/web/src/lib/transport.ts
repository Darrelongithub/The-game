// src/lib/transport.ts — the ONE seam between the UI and the game server.
//
// Two implementations behind NEXT_PUBLIC_TRANSPORT:
//   "socket" (DEFAULT) — the shipped build talks to the real same-origin server.
//   "mock"             — an in-memory scripted 4-player game, full phase flow,
//                        for developing screens with no server running.
//
// The UI only ever sees this interface, the frozen contracts, and nothing else.
import type {
  Consent,
  DarePassRequest,
  FinaleView,
  InterludeView,
  JoinReply,
  JoinRequest,
  PlayerId,
  RevealView,
  RoomCode,
  RoomView,
  RoundView,
  SecretDeckView,
  SubmitRequest,
} from "@shared/contracts.ts";

export interface TransportHandlers {
  /** full snapshot — server authoritative, always replaces local state */
  onState?: (view: RoomView) => void;
  onRound?: (view: RoundView) => void;
  onReveal?: (view: RevealView) => void;
  onInterlude?: (view: InterludeView) => void;
  /** broadcast-safe public slides only — identical on every phone */
  onFinale?: (view: FinaleView) => void;
  /** PRIVATE — this phone only, never broadcast (spec §7) */
  onSecrets?: (deck: SecretDeckView) => void;
  onDeleted?: () => void;
  onError?: (e: { code: string; message: string }) => void;
  /** transport-level connection state (drives the connection-lost overlay) */
  onConnection?: (connected: boolean, info?: { resuming?: boolean }) => void;
}

export interface Transport {
  readonly mode: "socket" | "mock";
  setHandlers(handlers: TransportHandlers): void;
  create(alias: string, consent: Consent): Promise<JoinReply & { code?: RoomCode }>;
  join(req: JoinRequest): Promise<JoinReply>;
  submit(req: SubmitRequest): Promise<{ ok: boolean; error?: string }>;
  darePass(req: DarePassRequest): Promise<{ ok: boolean; error?: string }> | void;
  start(): void;
  addBot(): void;
  skipRound(): void;
  customPrompts(lines: string[]): void;
  voteHeatDown(): void;
  deleteRoom(): void;
  /** re-join with the stored secret (+ full snapshot). Called on boot and on
   *  every visibilitychange — spec §1/§11.11. */
  resume(): void;
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

/** Helper: what the local player is being asked to answer right now. */
export function roundTargetsMe(round: RoundView | null, you: PlayerId | null): boolean {
  if (!round || !you) return false;
  if (!round.onlyPlayers || round.onlyPlayers.length === 0) return true;
  return round.onlyPlayers.includes(you);
}

export type { Transport as TransportApi };

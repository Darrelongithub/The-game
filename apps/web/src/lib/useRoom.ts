"use client";
// src/lib/useRoom.ts — the one hook every screen uses.
//
// Owns: the transport instance, the current RoomView (full snapshots only),
// your PlayerId, the senders, connection/reconnect state, and the PRIVATE
// `secrets` deck (this phone only, never broadcast — spec §7).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Consent,
  FinaleView,
  InterludeView,
  JoinReply,
  PlayerId,
  ResponseValue,
  RevealView,
  RoomCode,
  RoomView,
  RoundView,
  SecretDeckView,
  SubmitRequest,
} from "@shared/contracts.ts";
import { createTransport, roundTargetsMe, transportMode, type Transport, type TransportHandlers } from "./transport";
import { demoAnswerValue } from "./demoAnswer";
import { clearSession, loadSession, saveSession } from "./session";

export interface UseRoom {
  mode: "socket" | "mock";
  view: RoomView | null;
  you: PlayerId | null;
  code: RoomCode | null;
  isHost: boolean;
  connected: boolean;
  resuming: boolean;
  error: string | null;
  round: RoundView | null;
  interlude: InterludeView | null;
  reveal: RevealView | null;
  finale: FinaleView | null;
  secrets: SecretDeckView | null;
  mustAnswer: boolean;
  /** lobby actions */
  createRoom: (alias: string, consent: Consent, options?: { demo?: boolean }) => Promise<JoinReply & { code?: RoomCode }>;
  /** "I'm ready for the pending reveal" (reveals wait for everyone) */
  ready: () => void;
  /** DEMO ROOMS (host only): puppeted seats played from this laptop */
  demo: boolean;
  demoAddPlayer: (alias: string) => Promise<{ ok: boolean; playerId?: PlayerId }>;
  demoRemovePlayer: (playerId: PlayerId) => void;
  demoSetBotMode: (playerId: PlayerId, mode: "auto" | "manual") => void;
  demoAnswerAs: (playerId: PlayerId) => void;
  demoAllReady: () => void;
  demoSpeed: (scale: number) => void;
  /** players still to press ready for the pending reveal; null when none is pending */
  awaitingReady: PlayerId[] | null;
  /** this phone has already pressed ready for the pending reveal */
  youAreReady: boolean;
  joinRoom: (code: RoomCode, alias: string, consent: Consent) => Promise<JoinReply>;
  start: () => void;
  addBot: () => void;
  skipRound: () => void;
  setCustomPrompts: (lines: string[]) => void;
  voteHeatDown: () => void;
  deleteRoom: () => void;
  /** play actions */
  submit: (value: ResponseValue) => Promise<{ ok: boolean; error?: string }>;
  darePass: (reason: string) => Promise<{ ok: boolean; error?: string }>;
  /** connection repair */
  retry: () => void;
  clearError: () => void;
  /** wipe the local session (used after `deleted` / a failed resume) */
  reset: () => void;
  hasSession: boolean;
}

let uuidCounter = 0;
export function clientUuid(): string {
  const c = globalThis.crypto;
  if (c && "randomUUID" in c) return c.randomUUID();
  uuidCounter += 1;
  return `u-${Date.now().toString(36)}-${uuidCounter}`;
}

/** Factory injection lets tests exercise slow chunk/network initialization. */
export function useRoom(factory: typeof createTransport = createTransport): UseRoom {
  const transportRef = useRef<Transport | null>(null);
  const transportReady = useRef<Promise<Transport> | null>(null);
  const [mode, setMode] = useState<"socket" | "mock">(transportMode);
  const [view, setView] = useState<RoomView | null>(null);
  const [you, setYou] = useState<PlayerId | null>(null);
  const [code, setCode] = useState<RoomCode | null>(null);
  const [connected, setConnected] = useState(true);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState<RoundView | null>(null);
  const [interlude, setInterlude] = useState<InterludeView | null>(null);
  const [reveal, setReveal] = useState<RevealView | null>(null);
  const [finale, setFinale] = useState<FinaleView | null>(null);
  const [secrets, setSecrets] = useState<SecretDeckView | null>(null);
  const [hasSession, setHasSession] = useState(false);

  useEffect(() => {
    const stored = loadSession();
    setHasSession(Boolean(stored));
    if (stored) {
      setYou(stored.you);
      setCode(stored.code);
    }

    const handlers: TransportHandlers = {
      onState: (next) => {
        setView(next);
        setRound(next.round ?? null);
        setCode(next.code);
        // Server-authoritative: a snapshot always wins over local guesses.
        setHasSession(true);
      },
      onRound: (next) => {
        setRound(next);
        setInterlude(null);
        setReveal(null);
      },
      onReveal: (next) => {
        setRound(null);
        setReveal(next);
      },
      onInterlude: (next) => {
        setRound(null);
        setReveal(null);
        setInterlude(next);
      },
      onFinale: (next) => {
        setRound(null);
        setInterlude(null);
        setReveal(null);
        setFinale(next);
      },
      onSecrets: (deck) => {
        // PRIVATE — this socket only. Never rendered anywhere but the deck.
        setSecrets(deck);
      },
      onDeleted: () => {
        resetLocal();
        setError("The room was deleted.");
      },
      onError: (e) => {
        if (e.code === "resume_failed") resetLocal();
        setError(e.message);
      },
      onConnection: (ok, info) => {
        setConnected(ok);
        setResuming(Boolean(ok && info?.resuming));
      },
    };

    let disposed = false;
    const ready = factory(handlers).then((transport) => {
      if (disposed) { transport.disconnect(); throw new Error("Room screen unmounted"); }
      transportRef.current = transport;
      setMode(transport.mode);
      if (stored) transport.resume();
      return transport;
    });
    transportReady.current = ready;
    void ready.catch(() => {
      if (!disposed) { setConnected(false); setError("Could not start the connection. Please reload."); }
    });

    // The real transport owns its visibility listener. Keep the mock's
    // snapshot refresh without issuing a second real rejoin on the same token.
    const onVisible = () => {
      const current = transportRef.current;
      if (document.visibilityState === "visible" && current?.mode === "mock") current.resume();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
      transportRef.current?.disconnect();
      transportRef.current = null;
      if (transportReady.current === ready) transportReady.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetLocal = useCallback(() => {
    transportRef.current?.forgetSession();
    clearSession();
    setYou(null);
    setCode(null);
    setView(null);
    setRound(null);
    setInterlude(null);
    setReveal(null);
    setFinale(null);
    setSecrets(null);
    setHasSession(false);
  }, []);

  const createRoom = useCallback(async (alias: string, consent: Consent, options?: { demo?: boolean }) => {
    const t = transportRef.current ?? await transportReady.current?.catch(() => null);
    if (!t) return { ok: false, error: "Not connected yet. Please retry." } satisfies JoinReply;
    setError(null);
    const reply = await t.create(alias, consent, options);
    if (reply.ok && reply.you) {
      setYou(reply.you);
      if (reply.state) setView(reply.state);
      const roomCode = reply.code ?? reply.state?.code ?? null;
      if (roomCode) setCode(roomCode);
      if (reply.secret && roomCode) {
        saveSession({ code: roomCode, you: reply.you, secret: reply.secret, alias });
      }
      setHasSession(true);
    } else if (reply.error) {
      setError(reply.error);
    }
    return reply;
  }, []);

  const joinRoom = useCallback(async (roomCode: RoomCode, alias: string, consent: Consent) => {
    const t = transportRef.current ?? await transportReady.current?.catch(() => null);
    if (!t) return { ok: false, error: "Not connected yet. Please retry." } satisfies JoinReply;
    setError(null);
    const reply = await t.join({ roomCode, alias, consent });
    if (reply.ok && reply.you) {
      setYou(reply.you);
      if (reply.state) setView(reply.state);
      setCode(roomCode);
      if (reply.secret) saveSession({ code: roomCode, you: reply.you, secret: reply.secret, alias });
      setHasSession(true);
    } else if (reply.error) {
      setError(reply.error);
    }
    return reply;
  }, []);

  const submit = useCallback(async (value: ResponseValue) => {
    const t = transportRef.current;
    if (!t || !round) return { ok: false, error: "No open round." };
    const req: SubmitRequest = { roundId: round.roundId, clientUuid: clientUuid(), value };
    const res = await t.submit(req);
    if (res.ok) setRound((r) => (r && r.roundId === round.roundId ? { ...r, youSubmitted: true } : r));
    else setError(res.error ?? "That answer didn't send.");
    return res;
  }, [round]);

  const darePass = useCallback(
    async (reason: string) => {
      const t = transportRef.current;
      if (!t || !round) return { ok: false, error: "No open dare." };
      const res = await t.darePass({ roundId: round.roundId, reason });
      if (res && res.ok) {
        setRound((r) => (r && r.roundId === round.roundId ? { ...r, youSubmitted: true } : r));
      } else if (res?.error) {
        setError(res.error);
      }
      return res ?? { ok: false, error: "Could not pass." };
    },
    [round]
  );

  const ready = useCallback(() => transportRef.current?.ready(), []);
  const demoAddPlayer = useCallback(async (alias: string) => {
    const t = transportRef.current;
    if (!t) return { ok: false };
    return t.demoAddPlayer(alias);
  }, []);
  const demoRemovePlayer = useCallback((playerId: PlayerId) => transportRef.current?.demoRemovePlayer(playerId), []);
  const demoSetBotMode = useCallback((playerId: PlayerId, mode: "auto" | "manual") => transportRef.current?.demoSetBotMode(playerId, mode), []);
  const demoAllReady = useCallback(() => transportRef.current?.demoAllReady(), []);
  const demoSpeed = useCallback((scale: number) => transportRef.current?.demoSpeed(scale), []);
  /** Send a plausible answer for a puppeted seat on the open round. */
  const demoAnswerAs = useCallback((playerId: PlayerId) => {
    const t = transportRef.current;
    if (!t || !round || !view) return;
    const value = demoAnswerValue(round, playerId, view.players);
    if (!value) return;
    t.demoAnswerAs({ playerId, roundId: round.roundId, clientUuid: clientUuid(), value });
  }, [round, view]);
  const start = useCallback(() => transportRef.current?.start(), []);
  const addBot = useCallback(() => transportRef.current?.addBot(), []);
  const skipRound = useCallback(() => transportRef.current?.skipRound(), []);
  const setCustomPrompts = useCallback(
    (lines: string[]) => transportRef.current?.customPrompts(lines),
    []
  );
  const voteHeatDown = useCallback(() => transportRef.current?.voteHeatDown(), []);
  const deleteRoom = useCallback(() => transportRef.current?.deleteRoom(), []);
  const retry = useCallback(() => transportRef.current?.resume(), []);

  const isHost = Boolean(view && you && view.hostId === you);
  const mustAnswer = useMemo(() => roundTargetsMe(round, you), [round, you]);
  // A reveal is pending while the snapshot carries a `ready` list: whoever is
  // not on it has not looked up yet, and the moment waits for them.
  const awaitingReady = useMemo<PlayerId[] | null>(() => {
    if (!view?.ready) return null;
    const readyIds = new Set(view.ready);
    return view.players.filter((p) => p.connected && !readyIds.has(p.id)).map((p) => p.id);
  }, [view]);
  const youAreReady = Boolean(view?.ready && you && view.ready.includes(you));

  return {
    mode,
    view,
    you,
    code,
    isHost,
    connected,
    resuming,
    error,
    round,
    interlude,
    reveal,
    finale,
    secrets,
    mustAnswer,
    createRoom,
    joinRoom,
    ready,
    demo: Boolean(view?.demo),
    demoAddPlayer,
    demoRemovePlayer,
    demoSetBotMode,
    demoAnswerAs,
    demoAllReady,
    demoSpeed,
    awaitingReady,
    youAreReady,
    start,
    addBot,
    skipRound,
    setCustomPrompts,
    voteHeatDown,
    deleteRoom,
    submit,
    darePass,
    retry,
    clearError: () => setError(null),
    reset: resetLocal,
    hasSession,
  };
}

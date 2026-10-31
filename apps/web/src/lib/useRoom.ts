"use client";
// src/lib/useRoom.ts — the one hook every screen uses.
//
// Owns: the transport instance, the current RoomView (full snapshots only),
// your PlayerId, the senders, connection/reconnect state, and the PRIVATE
// `secrets` deck (this phone only, never broadcast).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BeatView,
  Consent,
  FinaleView,
  JoinReply,
  PlayerId,
  ProfileAnswers,
  ResponseValue,
  RoomCode,
  RoomView,
  RoundView,
  SecretDeckView,
  SubmitRequest,
} from "@shared/contracts.ts";
import { createTransport, makeClientUuid, transportMode, type Transport, type TransportHandlers } from "./transport";
import { clearSession, loadSession, saveSession } from "./session";

export interface UseRoom {
  mode: "socket" | "mock";
  view: RoomView | null;
  you: PlayerId | null;
  code: RoomCode | null;
  /** The laptop is bound to tonight's room (never a player seat). */
  isHost: boolean;
  connected: boolean;
  resuming: boolean;
  error: string | null;
  round: RoundView | null;
  beat: BeatView | null;
  finale: FinaleView | null;
  secrets: SecretDeckView | null;
  /** A phone joins with the code from the QR. */
  joinRoom: (code: RoomCode, alias: string, consent: Consent, profile: ProfileAnswers) => Promise<JoinReply>;
  /** The laptop binds with its token — no code to type. */
  bindHost: (token: string) => Promise<{ ok: boolean; error?: string }>;
  /** The lobby tick: "I'm in". */
  setLobbyReady: (ready: boolean) => void;
  /** This phone has ticked "I'm in" in the lobby. */
  youAreLobbyReady: boolean;
  /** "Ready for the results" — the ONE ready gate. */
  ready: () => void;
  /** This phone has said "Ready for the results". */
  youAreReady: boolean;
  start: () => void;
  forceResults: () => void;
  addBot: () => void;
  skipRound: () => void;
  deleteRoom: () => void;
  submit: (value: ResponseValue) => Promise<{ ok: boolean; error?: string }>;
  /** connection repair */
  retry: () => void;
  clearError: () => void;
  /** wipe the local session (used after `deleted` / a failed resume) */
  reset: () => void;
  hasSession: boolean;
}

export function clientUuid(): string {
  return makeClientUuid();
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
  const [beat, setBeat] = useState<BeatView | null>(null);
  const [finale, setFinale] = useState<FinaleView | null>(null);
  const [secrets, setSecrets] = useState<SecretDeckView | null>(null);
  const [hasSession, setHasSession] = useState(false);
  const [isHost, setIsHost] = useState(false);

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
        setBeat(null);
      },
      onBeat: (next) => {
        setBeat(next);
      },
      onFinale: (next) => {
        setRound(null);
        setBeat(null);
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
    setBeat(null);
    setFinale(null);
    setSecrets(null);
    setHasSession(false);
    setIsHost(false);
  }, []);

  const joinRoom = useCallback(async (roomCode: RoomCode, alias: string, consent: Consent, profile: ProfileAnswers) => {
    const t = transportRef.current ?? await transportReady.current?.catch(() => null);
    if (!t) return { ok: false, error: "Not connected yet. Please retry." } satisfies JoinReply;
    setError(null);
    const reply = await t.join({ roomCode, alias, consent, profile });
    if (reply.ok && reply.you) {
      setYou(reply.you);
      setCode(roomCode);
      setIsHost(false);
      if (reply.state) setView(reply.state);
      if (reply.secret) saveSession({ code: roomCode, you: reply.you, secret: reply.secret, alias });
      setHasSession(true);
    } else if (reply.error) {
      setError(reply.error);
    }
    return reply;
  }, []);

  const bindHost = useCallback(async (token: string) => {
    const t = transportRef.current ?? await transportReady.current?.catch(() => null);
    if (!t) return { ok: false, error: "Not connected yet. Please retry." };
    setError(null);
    const reply = await t.hostJoin(token);
    if (reply.ok) setIsHost(true);
    else setError(reply.error ?? "That host link is not valid.");
    return reply;
  }, []);

  const submit = useCallback(async (value: ResponseValue) => {
    const t = transportRef.current;
    if (!t || !round) return { ok: false, error: "No question right now." };
    const req: SubmitRequest = { roundId: round.roundId, clientUuid: clientUuid(), value };
    const res = await t.submit(req);
    if (res.ok) setRound((r) => (r && r.roundId === round.roundId ? { ...r, youSubmitted: true } : r));
    else setError(res.error ?? "That answer didn't send.");
    return res;
  }, [round]);

  const setLobbyReady = useCallback((isReady: boolean) => transportRef.current?.lobbyReady(isReady), []);
  const ready = useCallback(() => transportRef.current?.ready(), []);
  const start = useCallback(() => transportRef.current?.start(), []);
  const forceResults = useCallback(() => transportRef.current?.forceResults(), []);
  const addBot = useCallback(() => transportRef.current?.addBot(), []);
  const skipRound = useCallback(() => transportRef.current?.skipRound(), []);
  const deleteRoom = useCallback(() => transportRef.current?.deleteRoom(), []);
  const retry = useCallback(() => transportRef.current?.resume(), []);

  const youAreReady = useMemo(
    () => Boolean(view?.ready && you && view.ready.includes(you)),
    [view, you],
  );
  const youAreLobbyReady = useMemo(
    () => Boolean(view?.lobbyReady && you && view.lobbyReady.includes(you)),
    [view, you],
  );

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
    beat,
    finale,
    secrets,
    joinRoom,
    bindHost,
    setLobbyReady,
    youAreLobbyReady,
    ready,
    youAreReady,
    start,
    forceResults,
    addBot,
    skipRound,
    deleteRoom,
    submit,
    retry,
    clearError: () => setError(null),
    reset: resetLocal,
    hasSession,
  };
}

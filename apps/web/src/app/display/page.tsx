"use client";
import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import type { FinaleView, InterludeView, RoomCode, RoomView, RoundView, RevealView } from "@shared/contracts.ts";
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "@shared/contracts.ts";
import { DisplayFinale, DisplayReveal, FinaleTheatre } from "./FinaleTheatre";
import { createFinaleRevealBuffer, subscribeToQueuedReveals } from "./queuedReveals";

const cleanCode = (raw: string): RoomCode => [...raw.toUpperCase()].filter(c => ROOM_CODE_ALPHABET.includes(c)).slice(0, ROOM_CODE_LENGTH).join("") as RoomCode;
const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL || undefined;

export default function DisplayPage() {
  const [code, setCode] = useState<RoomCode>("" as RoomCode);
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<RoomView | null>(null);
  const [round, setRound] = useState<RoundView | null>(null);
  const [reveal, setReveal] = useState<RevealView | null>(null);
  const [interlude, setInterlude] = useState<InterludeView | null>(null);
  const [finale, setFinale] = useState<FinaleView | null>(null);
  // Null means ordinary live reveals; an array is a display-only finale queue.
  const [queuedReveals, setQueuedReveals] = useState<RevealView[] | null>(null);
  const [status, setStatus] = useState("Enter the room code shown on the host's phone.");

  useEffect(() => {
    const fromUrl = cleanCode(new URLSearchParams(window.location.search).get("code") ?? "");
    if (fromUrl.length === ROOM_CODE_LENGTH) { setCode(fromUrl); setDraft(fromUrl); }
  }, []);

  useEffect(() => {
    if (code.length !== ROOM_CODE_LENGTH) return;
    const socket = io(SERVER_URL, { transports: ["polling", "websocket"], reconnection: true, withCredentials: true });
    let seq = -1;
    const queued = createFinaleRevealBuffer();
    const joinDisplay = () => {
      queued.reset();
      setStatus("Connecting to the public room display…");
      socket.emit("display_join", { roomCode: code }, (reply: { ok: boolean; state?: RoomView; error?: string }) => {
        if (!reply.ok) { setStatus(reply.error ?? "Could not open this display."); return; }
        if (reply.state && reply.state.seq >= seq) { seq = reply.state.seq; queued.setPhase(reply.state.phase); setState(reply.state); setRound(reply.state.round); }
        setStatus("Connected · public display only");
      });
    };
    socket.on("connect", joinDisplay);
    socket.on("disconnect", () => setStatus("Connection lost · reconnecting…"));
    socket.on("state", (view: RoomView) => {
      if (view.seq <= seq) return;
      seq = view.seq; queued.setPhase(view.phase); setState(view); setRound(view.round);
    });
    socket.on("round", (view: RoundView) => { queued.setPhase(view.phase); setRound(view); setReveal(null); setInterlude(null); setQueuedReveals(null); });
    socket.on("reveal", (view: RevealView) => { if (queued.capture(view)) return; setRound(null); setReveal(view); });
    socket.on("interlude", (view: InterludeView) => { queued.setPhase("interlude"); setRound(null); setReveal(null); setInterlude(view); });
    subscribeToQueuedReveals(socket, (views) => { setRound(null); setReveal(null); setInterlude(null); setQueuedReveals(views); });
    socket.on("finale", (view: FinaleView) => { const views = queued.take(); if (views) setQueuedReveals(views); setRound(null); setReveal(null); setInterlude(null); setFinale(view); });
    socket.on("deleted", () => { queued.reset(); setState(null); setRound(null); setReveal(null); setInterlude(null); setFinale(null); setQueuedReveals(null); setStatus("This room was deleted."); socket.disconnect(); });
    return () => { socket.removeAllListeners(); socket.disconnect(); };
  }, [code]);

  if (!code || code.length !== ROOM_CODE_LENGTH) return (
    <main className="screen flex min-h-[100dvh] items-center justify-center px-5 py-10 text-white">
      <form className="glass-card w-full max-w-md space-y-4 p-6" onSubmit={e => { e.preventDefault(); const valid = cleanCode(draft); if (valid.length === ROOM_CODE_LENGTH) { setCode(valid); window.history.replaceState(null, "", `/display?code=${valid}`); } }}>
        <p className="text-xs uppercase tracking-[0.25em] text-lime-accent">Public room display</p>
        <h1 className="text-3xl font-bold">Put the night on the big screen.</h1>
        <label htmlFor="display-code" className="block text-sm text-white/70">Room code</label>
        <input id="display-code" className="field text-center text-2xl uppercase tracking-[0.5em]" value={draft} onChange={e => setDraft(cleanCode(e.target.value))} maxLength={ROOM_CODE_LENGTH} autoCapitalize="characters" />
        <button className="min-h-12 w-full rounded-2xl bg-lime-accent px-5 py-3 font-bold text-black">Open public display</button>
        <p className="text-xs text-white/45">This screen receives public beats only. It never joins as a player or receives private reveal cards.</p>
      </form>
    </main>
  );

  // Queue replays after a reconnect keep the host's position. A genuinely new
  // ordered set of round IDs gets a fresh theatre starting at the first reveal.
  const active = queuedReveals !== null ? <FinaleTheatre key={JSON.stringify(queuedReveals.map(item => item.roundId))} reveals={queuedReveals} finale={finale} />
    : finale ? <DisplayFinale view={finale} />
    : interlude ? <section className="glass-card mx-auto max-w-4xl p-10 text-center"><p className="text-sm uppercase tracking-[0.3em] text-lime-accent">{interlude.headline}</p><p className="mt-5 text-3xl font-bold">{interlude.sub}</p></section>
    : reveal ? <DisplayReveal reveal={reveal} />
    : round ? <section className="mx-auto w-full max-w-5xl text-center"><p className="text-sm uppercase tracking-[0.3em] text-lime-accent">{round.phase} · round {round.index}</p><h1 className="mt-8 text-5xl font-black leading-tight md:text-7xl">{round.promptText}</h1></section>
    : <section className="glass-card mx-auto max-w-4xl p-10 text-center"><p className="text-sm uppercase tracking-[0.3em] text-lime-accent">{state?.phase ?? "Room"}</p><h1 className="mt-4 text-4xl font-bold">Waiting for the next beat</h1></section>;

  return <main className="screen min-h-[100dvh] px-6 py-8 text-white md:px-12 md:py-12">
    <header className="mb-10 flex items-center justify-between gap-4"><div><p className="text-xs uppercase tracking-[0.28em] text-white/45">Public room display</p><h1 className="font-display text-2xl font-bold">Room {code}</h1></div><p className="text-sm text-lime-accent" role="status">{status}</p></header>
    {active}
    {state && <footer className="mx-auto mt-10 flex max-w-5xl flex-wrap justify-center gap-3">{state.players.map(player => <span key={player.id} className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm">{player.alias} {player.connected ? "· here" : "· away"}</span>)}</footer>}
  </main>;
}

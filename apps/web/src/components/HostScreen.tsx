"use client";
// components/HostScreen.tsx — THE LAPTOP.
//
// The laptop runs the night and never answers:
//   • the join QR (the room is already bound — nobody types a code)
//   • who is in the room, with their ready ticks
//   • Start
//   • how far the night has got
//   • the reveal
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { FinaleView, RoomView } from "@shared/contracts.ts";
import { qrMatrix, qrSvgPath } from "@/lib/qr";
import { Flame } from "@/components/Flame";
import { GlassCard } from "@/components/GlassCard";
import { GlowButton } from "@/components/GlowButton";
import { FinaleScreen } from "@/components/FinaleScreen";
import { LoadingScreen } from "@/components/LoadingScreen";

export function HostScreen({
  view,
  finale,
  onStart,
  onForceResults,
  onSkipRound,
  onDelete,
}: {
  view: RoomView | null;
  finale: FinaleView | null;
  onStart: () => void;
  onForceResults: () => void;
  onSkipRound: () => void;
  onDelete: () => void;
}) {
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const joinUrl = view ? `${origin}/?room=${view.code}` : "";
  const qr = useMemo(() => (joinUrl ? qrMatrix(joinUrl) : null), [joinUrl]);
  const path = useMemo(() => (qr ? qrSvgPath(qr) : ""), [qr]);

  const readyIds = new Set(view?.lobbyReady ?? []);
  const progress = view?.progress;
  const generation = view?.generation;

  if (finale) {
    return <FinaleScreen view={finale} roomCode={view?.code} />;
  }

  if (view?.phase === "generating") {
    return <LoadingScreen done={generation?.done ?? 0} total={generation?.total ?? 40} />;
  }

  return (
    <main className="screen min-h-[100dvh] px-5 py-8 md:px-10">
      <div className="mx-auto grid w-full max-w-6xl gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* left: the room */}
        <section className="flex flex-col gap-6">
          <header className="flex items-center gap-4">
            <Flame size={56} />
            <div>
              <p className="text-[10.5px] uppercase tracking-[0.28em] text-white/45">Host laptop</p>
              <h1 className="font-display text-2xl font-bold text-white">
                Room <span className="tracking-[0.3em] text-lime-accent">{view?.code ?? "····"}</span>
              </h1>
            </div>
          </header>

          {/* the public line for the case that is open (a look chain) */}
          {view?.headline ? (
            <GlassCard className="p-5" data-testid="host-headline">
              <p className="text-[10.5px] uppercase tracking-[0.24em] text-white/45">Right now</p>
              <p className="mt-2 font-display text-2xl font-bold text-white">{view.headline}</p>
            </GlassCard>
          ) : null}

          {/* progress */}
          <GlassCard className="p-5">
            <div className="flex items-baseline justify-between gap-4">
              <p className="text-[10.5px] uppercase tracking-[0.24em] text-white/45">Tonight</p>
              <p className="tabular-nums text-sm text-white/70" data-testid="host-progress">
                {progress ? `${progress.index} / ${progress.total} cases` : "Not started"}
              </p>
            </div>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-gradient-to-r from-lime-accent to-purple-primary"
                style={{
                  width: progress && progress.total ? `${Math.round((progress.index / progress.total) * 100)}%` : "0%",
                }}
              />
            </div>
            <p className="mt-3 text-xs text-white/40">
              The laptop never answers. Every phone gets its own question.
            </p>
          </GlassCard>

          {/* players */}
          <GlassCard className="p-5">
            <p className="mb-3 text-[10.5px] uppercase tracking-[0.24em] text-white/45">
              In the room · {view?.players.length ?? 0}
            </p>
            <ul className="flex flex-col gap-2" data-testid="host-players">
              {(view?.players ?? []).map((player) => (
                <li key={player.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-white/85">
                    {player.alias}
                    {player.isBot && <span className="ml-2 text-[10px] uppercase tracking-[0.16em] text-white/35">bot</span>}
                    {!player.connected && <span className="ml-2 text-[10px] uppercase tracking-[0.16em] text-alert">away</span>}
                  </span>
                  <span
                    className="text-[10.5px] uppercase tracking-[0.18em]"
                    style={{ color: readyIds.has(player.id) ? "var(--lime-accent)" : "rgba(245,243,255,0.3)" }}
                    data-testid="host-ready-tick"
                  >
                    {readyIds.has(player.id) ? "ready" : "not ready"}
                  </span>
                </li>
              ))}
            </ul>
          </GlassCard>

          {/* controls */}
          <div className="flex flex-wrap gap-3">
            <GlowButton onClick={onStart} disabled={view?.phase !== "lobby"} data-testid="host-start">
              {view?.phase === "lobby" ? "Start the night" : "Started"}
            </GlowButton>
            <button
              type="button"
              onClick={onForceResults}
              disabled={view?.phase !== "results"}
              className="min-h-[48px] rounded-2xl border border-white/20 px-5 text-sm text-white disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-accent"
            >
              Show the results
            </button>
            <button
              type="button"
              onClick={onSkipRound}
              disabled={view?.phase !== "play"}
              className="min-h-[48px] rounded-2xl border border-white/20 px-5 text-sm text-white disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-accent"
            >
              Skip this case
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="min-h-[48px] rounded-2xl border border-alert/40 px-5 text-sm text-alert focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-accent"
            >
              Delete room
            </button>
          </div>
        </section>

        {/* right: the join QR */}
        <aside className="flex flex-col gap-4">
          <GlassCard className="flex flex-col items-center gap-4 p-6">
            <p className="text-[10.5px] uppercase tracking-[0.24em] text-white/45">Scan to join</p>
            {qr ? (
              <svg
                viewBox={`0 0 ${qr.size} ${qr.size}`}
                className="h-56 w-56 rounded-lg bg-white p-2"
                role="img"
                aria-label="QR code for the join link"
                data-testid="host-qr"
              >
                <path d={path} fill="#0d0617" />
              </svg>
            ) : (
              <div className="flex h-56 w-56 items-center justify-center rounded-lg bg-white/10 text-xs text-white/40">
                Waiting for the room…
              </div>
            )}
            <p className="text-center text-xs text-white/45">or open</p>
            <p className="break-all text-center text-xs text-lime-accent" data-testid="host-join-url">
              {joinUrl || "—"}
            </p>
            <p className="text-center text-sm tracking-[0.4em] text-white/85">{view?.code ?? "····"}</p>
          </GlassCard>
          <motion.p
            className="text-center text-[11px] text-white/35"
            animate={{ opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 3, repeat: Infinity }}
          >
            Same Wi-Fi. One phone each.
          </motion.p>
        </aside>
      </div>
    </main>
  );
}

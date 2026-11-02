"use client";
// components/DemoPanel.tsx — ROUND 4: the host tests the whole game alone.
//
// A demo room is a real room (real engine, real scoring) where every seat but
// the host's is a puppet played from this laptop. This panel is the puppeteer's
// console: add/remove seats, flip a seat between answering itself and waiting
// for a tap, hand-answer the open round, release a pending reveal, and slow the
// whole night down. It is never rendered outside a demo room.
import { useState } from "react";
import type { PlayerId, PlayerView, Phase, RoundView } from "@shared/contracts.ts";
import { MAX_PLAYERS } from "@shared/contracts.ts";
import { GlassCard } from "@/components/GlassCard";
import { GlowButton } from "@/components/GlowButton";
import { clsx } from "clsx";

export function DemoPanel({
  players,
  you,
  phase,
  round,
  awaitingReady,
  onAddPlayer,
  onRemovePlayer,
  onSetMode,
  onAnswerAs,
  onAllReady,
  onSpeed,
}: {
  players: PlayerView[];
  you: PlayerId | null;
  phase: Phase;
  round: RoundView | null;
  /** players still to press ready; non-null while a reveal is pending */
  awaitingReady: PlayerId[] | null;
  onAddPlayer: (alias: string) => void;
  onRemovePlayer: (playerId: PlayerId) => void;
  onSetMode: (playerId: PlayerId, mode: "auto" | "manual") => void;
  onAnswerAs: (playerId: PlayerId) => void;
  onAllReady: () => void;
  onSpeed: (scale: number) => void;
}) {
  const [alias, setAlias] = useState("");
  const [speed, setSpeed] = useState(1);
  const lobby = phase === "lobby";
  // Every seat that is not this phone is a puppet candidate. The server is the
  // authority (a real friend who joined stays a real friend), so a wrong tap
  // simply comes back as an error.
  const puppets = players.filter((p) => p.id !== you);
  const canAnswer = Boolean(round) && round?.expectsAnswer !== false;

  return (
    <GlassCard className="w-full p-4 md:p-5" data-testid="demo-panel">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="font-display text-heading text-white">Demo room</h2>
        <span className="text-[10px] uppercase tracking-[0.18em] text-lime-accent">one laptop</span>
      </div>
      <p className="mb-4 text-xs leading-relaxed text-white/50">
        Play every seat yourself. The engine cannot tell the difference — the night scores exactly like a real one.
      </p>

      <ul className="mb-4 flex flex-col gap-2">
        {puppets.length === 0 && (
          <li className="text-xs text-white/40">No demo seats yet. Add one below.</li>
        )}
        {puppets.map((p) => (
          <li key={p.id} className="flex min-h-[48px] flex-wrap items-center gap-2 rounded-xl bg-white/5 px-2 py-1.5">
            <span className="truncate text-sm text-white">{p.alias}</span>
            <div className="ml-auto flex items-center gap-1.5">
              {(["auto", "manual"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onSetMode(p.id, mode)}
                  aria-pressed={mode === "auto"}
                  className={clsx(
                    "min-h-[40px] rounded-lg px-2.5 text-[11px] uppercase tracking-wider",
                    mode === "auto" ? "bg-lime-accent/20 text-lime-accent" : "bg-white/10 text-white/55"
                  )}
                >
                  {mode === "auto" ? "Auto" : "Manual"}
                </button>
              ))}
              {lobby && (
                <button
                  type="button"
                  onClick={() => onRemovePlayer(p.id)}
                  className="min-h-[40px] rounded-lg px-2.5 text-[11px] uppercase tracking-wider text-alert/80"
                  aria-label={`Remove ${p.alias}`}
                >
                  Remove
                </button>
              )}
            </div>
            {!lobby && canAnswer && (
              <button
                type="button"
                onClick={() => onAnswerAs(p.id)}
                className="min-h-[40px] w-full rounded-lg bg-white/10 text-xs text-white/80"
              >
                Answer this round for {p.alias}
              </button>
            )}
          </li>
        ))}
      </ul>

      {lobby && (
        <form
          className="mb-4 flex gap-2"
          onSubmit={(event) => { event.preventDefault(); const name = alias.trim(); if (!name) return; onAddPlayer(name); setAlias(""); }}
        >
          <input
            className="field"
            value={alias}
            onChange={(e) => setAlias(e.target.value.slice(0, 14))}
            placeholder="Seat name"
            aria-label="Demo seat name"
            autoComplete="off"
            maxLength={14}
          />
          <GlowButton type="submit" variant="accent" className="shrink-0 px-4 text-sm" disabled={alias.trim().length < 2 || players.length >= MAX_PLAYERS}>
            Add seat
          </GlowButton>
        </form>
      )}

      {awaitingReady && (
        <GlowButton className="mb-4 w-full" onClick={onAllReady}>
          Everyone&apos;s ready ({awaitingReady.length} left)
        </GlowButton>
      )}

      <label className="block text-[11px] uppercase tracking-[0.18em] text-white/45" htmlFor="demo-speed">
        Night speed · {speed.toFixed(1)}×
      </label>
      <input
        id="demo-speed"
        type="range"
        min={0.1}
        max={1}
        step={0.1}
        value={speed}
        onChange={(event) => {
          const next = Number(event.target.value);
          setSpeed(next);
          onSpeed(next);
        }}
        className="mt-2 w-full accent-[#b6ff3c]"
      />
      <p className="mt-1 text-[11px] text-white/35">0.1× is a fast rehearsal; 1× is the real night&apos;s clock.</p>
    </GlassCard>
  );
}

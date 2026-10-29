"use client";
// components/LobbyScreen.tsx — Agent A. Big room code, live player list with
// connection dots, and the four host-only controls from spec §1.
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { PlayerId, RoomCode, RoomView } from "@shared/contracts.ts";
import { MAX_PLAYERS, MIN_PLAYERS } from "@shared/contracts.ts";
import { GlassCard } from "@/components/GlassCard";
import { GlowButton } from "@/components/GlowButton";
import { staggerContainer, staggerItem } from "@/lib/motion";
import { clsx } from "clsx";

export function LobbyScreen({
  view,
  you,
  code,
  isHost,
  mode,
  busy,
  onStart,
  onAddBot,
  onCustomPrompts,
  onDelete,
  onHeatDown,
}: {
  view: RoomView;
  you: PlayerId | null;
  code: RoomCode | null;
  isHost: boolean;
  mode: "socket" | "mock";
  busy?: boolean;
  onStart: () => void;
  onAddBot: () => void;
  onCustomPrompts: (lines: string[]) => void;
  onDelete: () => void;
  onHeatDown: () => void;
}) {
  const [showPrompts, setShowPrompts] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const total = view.players.length;
  const connected = view.players.filter((p) => p.connected).length;
  const canStart = total >= MIN_PLAYERS;
  const lines = promptText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 10);

  return (
    <main className="screen relative flex flex-col items-center px-5 py-8 gap-5">
      <motion.div
        variants={staggerContainer}
        initial="initial"
        animate="animate"
        className="w-full max-w-lg flex flex-col gap-5"
      >
        {/* room code — the biggest thing on the screen, on purpose */}
        <motion.div variants={staggerItem} className="text-center">
          <p className="text-[11px] uppercase tracking-[0.28em] text-white/45 mb-3">Room code</p>
          <div className="font-display text-[clamp(3.2rem,18vw,5.5rem)] leading-none tracking-[0.14em] text-white"
               style={{ textShadow: "0 0 60px rgba(139,47,224,0.65)" }}>
            {code ?? view.code}
          </div>
          <p className="mt-3 text-sm text-white/50">
            Everyone opens this same site and types the code. No install.
          </p>
        </motion.div>

        {/* players */}
        <motion.div variants={staggerItem}>
          <GlassCard className="w-full p-4 md:p-5">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="font-display text-heading text-white">In the room</h2>
              <span className="text-xs text-white/45 tabular-nums">
                {connected} connected · {total}/{MAX_PLAYERS}
              </span>
            </div>

            <ul className="flex flex-col gap-1.5">
              {view.players.map((p, i) => (
                <motion.li
                  key={p.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04 }}
                  className="flex items-center gap-3 min-h-[48px] rounded-xl px-2"
                >
                  <span
                    className={clsx(
                      "h-2.5 w-2.5 rounded-full shrink-0",
                      p.connected ? "bg-lime-accent" : "bg-white/25"
                    )}
                    style={p.connected ? { boxShadow: "0 0 12px rgba(182,255,60,0.8)" } : undefined}
                    aria-label={p.connected ? "connected" : "disconnected"}
                  />
                  <span className="text-white truncate">{p.alias}</span>
                  {p.id === you && <span className="text-[10px] uppercase tracking-wider text-lime-accent">you</span>}
                  {p.isBot && <span className="text-[10px] uppercase tracking-wider text-white/35">bot</span>}
                  {view.hostId === p.id && (
                    <span className="ml-auto text-[10px] uppercase tracking-wider text-purple-primary">host</span>
                  )}
                </motion.li>
              ))}
            </ul>

            {!canStart && (
              <p className="mt-3 text-[11px] text-white/40">
                Needs {MIN_PLAYERS}+ players. Solo testing? {isHost ? "Add bots to fill the seats." : "The host can add bots."}
              </p>
            )}
          </GlassCard>
        </motion.div>

        {/* host controls */}
        {isHost ? (
          <motion.div variants={staggerItem} className="flex flex-col gap-2.5">
            <GlowButton className="w-full" onClick={onStart} disabled={!canStart || busy}>
              {canStart ? `Start the night · ${total} players` : `Start (needs ${MIN_PLAYERS}+)`}
            </GlowButton>

            <div className="grid grid-cols-2 gap-2.5">
              <GlowButton variant="accent" className="w-full" onClick={onAddBot} disabled={total >= MAX_PLAYERS}>
                Add bot
              </GlowButton>
              <GlowButton variant="accent" className="w-full" onClick={() => setShowPrompts((v) => !v)}>
                Custom prompts
              </GlowButton>
            </div>

            <AnimatePresence>
              {showPrompts && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <GlassCard className="p-4 mt-1">
                    <p className="text-xs text-white/50 mb-2 leading-relaxed">
                      One per line, max 10, max 160 chars. Optional <code className="text-lime-accent">spicy:</code> /{" "}
                      <code className="text-lime-accent">deep:</code> / <code className="text-lime-accent">dare:</code> prefix.
                      Tonight&apos;s bank only — deleted with the room.
                    </p>
                    <textarea
                      className="field min-h-[120px] font-body"
                      value={promptText}
                      onChange={(e) => setPromptText(e.target.value.slice(0, 2000))}
                      placeholder={"deep: What do you lie about to {P1}?\nspicy: Rate {P2}'s flirting, 1–10."}
                      aria-label="Custom prompts, one per line"
                    />
                    <div className="flex items-center justify-between mt-2">
                      <span className="text-[11px] text-white/35 tabular-nums">{lines.length}/10 lines</span>
                      <GlowButton
                        variant="accent"
                        className="px-4 py-2 text-sm"
                        onClick={() => onCustomPrompts(lines)}
                        disabled={lines.length === 0}
                      >
                        Send to the bank
                      </GlowButton>
                    </div>
                  </GlassCard>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        ) : (
          <motion.div variants={staggerItem}>
            <GlassCard className="p-5 text-center">
              <p className="text-white/70 text-sm">
                Waiting on the host to start. Get comfortable — the first prompt lands hard.
              </p>
            </GlassCard>
          </motion.div>
        )}

        {/* heat vote + room kill switch */}
        <motion.div variants={staggerItem} className="flex flex-col gap-2">
          <button
            type="button"
            onClick={onHeatDown}
            className="min-h-[48px] rounded-2xl border border-white/12 text-white/55 text-sm"
          >
            Vote to keep the heat where it is (never up)
          </button>

          {!confirmDelete ? (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="min-h-[48px] rounded-2xl text-alert/80 text-xs uppercase tracking-[0.18em]"
            >
              Delete room
            </button>
          ) : (
            <div className="rounded-2xl border border-alert/40 bg-alert/10 p-4">
              <p className="text-sm text-white mb-3">
                Delete this room for everyone, right now? Nothing comes back.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <GlowButton variant="accent" className="w-full text-sm" onClick={() => setConfirmDelete(false)}>
                  Keep it
                </GlowButton>
                <GlowButton
                  className="w-full text-sm bg-gradient-to-r from-alert to-purple-primary"
                  onClick={onDelete}
                >
                  Delete
                </GlowButton>
              </div>
            </div>
          )}
        </motion.div>

        {mode === "mock" && (
          <p className="text-center text-[10px] uppercase tracking-[0.2em] text-white/25">
            mock transport · scripted 4-player game
          </p>
        )}
      </motion.div>
    </main>
  );
}

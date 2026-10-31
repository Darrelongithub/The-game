"use client";
// components/LobbyScreen.tsx — the phone's waiting room.
//
// The host runs the night from the laptop. The phone waits, ticks "I'm ready"
// and watches who else is in.
import { motion } from "framer-motion";
import type { PlayerId, RoomView } from "@shared/contracts.ts";
import { GlassCard } from "@/components/GlassCard";
import { GlowButton } from "@/components/GlowButton";
import { Flame } from "@/components/Flame";

export function LobbyScreen({
  view,
  you,
  onReady,
  onDelete,
}: {
  view: RoomView;
  you: PlayerId | null;
  onReady: (ready: boolean) => void;
  onDelete: () => void;
}) {
  const readyIds = new Set(view.lobbyReady ?? []);
  const youAreReady = Boolean(you && readyIds.has(you));

  return (
    <main className="screen relative flex flex-col items-center justify-center px-5 py-10">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md flex flex-col items-center gap-5"
      >
        <Flame size={72} />
        <h1 className="font-display text-heading text-center">Waiting for the host</h1>
        <p className="text-sm text-white/55 text-center max-w-xs">
          The room is <span className="text-white/85 font-semibold tracking-[0.3em]">{view.code}</span>.
          The host starts the night when everybody is in.
        </p>

        <GlassCard className="w-full p-5">
          <p className="text-[10.5px] uppercase tracking-[0.28em] text-white/45 mb-3">
            In the room · {view.players.length}
          </p>
          <ul className="flex flex-col gap-2" data-testid="lobby-players">
            {view.players.map((player) => {
              const ready = readyIds.has(player.id);
              return (
                <li key={player.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className={player.id === you ? "text-lime-accent" : "text-white/85"}>
                    {player.alias}{player.id === you ? " (you)" : ""}
                  </span>
                  <span
                    className="text-[10.5px] uppercase tracking-[0.18em]"
                    style={{ color: ready ? "var(--lime-accent)" : "rgba(245,243,255,0.35)" }}
                    data-testid="ready-tick"
                    data-ready={ready ? "1" : "0"}
                  >
                    {ready ? "ready" : "not ready"}
                  </span>
                </li>
              );
            })}
          </ul>
        </GlassCard>

        <GlowButton
          className="w-full"
          variant={youAreReady ? "primary" : "accent"}
          onClick={() => onReady(!youAreReady)}
          data-testid="ready-button"
        >
          {youAreReady ? "I'm ready ✓" : "I'm ready"}
        </GlowButton>

        <p className="text-[11px] text-white/35 text-center max-w-xs">
          Your phone answers the questions. The laptop never does.
        </p>

        <button
          type="button"
          onClick={onDelete}
          className="min-h-[44px] text-xs text-white/35 underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-accent"
        >
          Delete this room
        </button>
      </motion.div>
    </main>
  );
}

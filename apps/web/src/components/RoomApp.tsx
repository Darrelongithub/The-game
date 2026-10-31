"use client";
// components/RoomApp.tsx — the phone's phase router.
//
// lobby → generating → play → results → (the reveal)
//
// The laptop has its own page (src/app/host/page.tsx). This one is the phone.
import { useEffect, useState } from "react";
import type { Consent, ProfileAnswers, RoomCode } from "@shared/contracts.ts";
import { AnimatePresence, motion } from "framer-motion";
import dynamic from "next/dynamic";
import { useRoom } from "@/lib/useRoom";
import { ConnectionLostOverlay } from "@/components/ConnectionLostOverlay";
import { GlowButton } from "@/components/GlowButton";
import { Flame } from "@/components/Flame";
import { pageVariants } from "@/lib/motion";

const loading = () => <main className="screen flex items-center justify-center" aria-busy="true">Getting things ready…</main>;
const JoinScreen = dynamic(() => import("@/components/JoinScreen").then((m) => m.JoinScreen), { loading });
const LobbyScreen = dynamic(() => import("@/components/LobbyScreen").then((m) => m.LobbyScreen), { loading });
const PlayScreen = dynamic(() => import("@/components/play/PlayScreen").then((m) => m.PlayScreen), { loading });

export function RoomApp() {
  const room = useRoom();
  const [joining, setJoining] = useState(false);

  const handleJoin = async (
    code: RoomCode,
    alias: string,
    consent: Consent,
    profile: ProfileAnswers,
  ) => {
    setJoining(true);
    try {
      return await room.joinRoom(code, alias, consent, profile);
    } finally {
      setJoining(false);
    }
  };

  const view = room.view;
  const inRoom = Boolean(view);

  return (
    <>
      <AnimatePresence key={inRoom ? "in-room" : "without-room"} mode="wait">
        {!inRoom && room.hasSession ? (
          <motion.div key="resuming" variants={pageVariants} initial="initial" animate="animate" exit="exit">
            <ResumeSplash onGiveUp={room.reset} />
          </motion.div>
        ) : !inRoom ? (
          <motion.div key="join" variants={pageVariants} initial="initial" animate="animate" exit="exit">
            <JoinScreen
              hasSession={room.hasSession}
              busy={joining}
              error={room.error}
              onJoin={handleJoin}
            />
          </motion.div>
        ) : view!.phase === "lobby" ? (
          <motion.div key="lobby" variants={pageVariants} initial="initial" animate="animate" exit="exit">
            <LobbyScreen
              view={view!}
              you={room.you}
              onReady={() => room.setLobbyReady(!room.youAreLobbyReady)}
              onDelete={room.deleteRoom}
            />
          </motion.div>
        ) : view!.phase === "closed" ? (
          <motion.div key="closed" variants={pageVariants} initial="initial" animate="animate" exit="exit">
            <ClosedScreen message={room.error ?? "That's the night. The room is closed."} onNew={room.reset} />
          </motion.div>
        ) : (
          // Do not transform this wrapper: the finale and room controls are
          // fixed to the viewport and must remain visible on mobile browsers.
          <motion.div key="play" className="min-h-[100dvh]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
            <PlayScreen room={room} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Reconnect handling is global: it can hit any screen, any phase. */}
      <ConnectionLostOverlay connected={room.connected} resuming={room.resuming} hasSession={room.hasSession} onRetry={room.retry} />
    </>
  );
}

function ResumeSplash({ onGiveUp }: { onGiveUp: () => void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setSlow(true), 6000);
    return () => clearTimeout(id);
  }, []);

  return (
    <main className="screen relative flex flex-col items-center justify-center gap-5 px-6 text-center">
      <Flame size={84} />
      <motion.p
        className="font-display text-heading text-white/85"
        animate={{ opacity: [0.6, 1, 0.6] }}
        transition={{ duration: 2, repeat: Infinity }}
      >
        Taking you back to the room…
      </motion.p>
      <p className="text-sm text-white/45 max-w-xs">
        Same phone, same seat. Your answers are still where you left them.
      </p>
      {slow && (
        <div className="glass-card mt-2 p-5 w-full max-w-sm">
          <p className="text-sm text-white/60 mb-3">
            The server isn&apos;t answering. It may have gone to sleep, or you&apos;re
            off the WiFi.
          </p>
          <GlowButton variant="accent" className="w-full" onClick={onGiveUp}>
            Start over
          </GlowButton>
        </div>
      )}
    </main>
  );
}

function ClosedScreen({ message, onNew }: { message: string; onNew: () => void }) {
  return (
    <main className="screen relative flex flex-col items-center justify-center gap-5 px-6 text-center">
      <Flame size={80} />
      <h1 className="font-display text-display-lg">Nothing left to reveal</h1>
      <p className="text-sm text-white/50 max-w-sm">{message}</p>
      <GlowButton className="mt-2 w-full max-w-xs" onClick={onNew}>
        New room
      </GlowButton>
      <p className="text-[11px] text-white/25 max-w-xs">
        Rooms are purged after 48 hours. Secrets never left the phone they were sent to.
      </p>
    </main>
  );
}

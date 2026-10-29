"use client";
// app/page.tsx — Agent A shell. Intro gate once per session, then:
//   no room → JoinScreen · lobby → LobbyScreen · anything else → PlayScreen.
// One page, no routing: the room state IS the route (spec §2).
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useRoom } from "@/lib/useRoom";
import { introDone, markIntroDone } from "@/lib/session";
import { OpeningSequence } from "@/components/OpeningSequence";
import { JoinScreen } from "@/components/JoinScreen";
import { LobbyScreen } from "@/components/LobbyScreen";
import { PlayScreen } from "@/components/play/PlayScreen";
import { ConnectionLostOverlay } from "@/components/ConnectionLostOverlay";
import { GlassCard } from "@/components/GlassCard";
import { GlowButton } from "@/components/GlowButton";
import { Flame } from "@/components/Flame";
import { pageVariants } from "@/lib/motion";

export default function PlayPage() {
  const room = useRoom();
  // "pending" until we've read sessionStorage (avoids an SSR/hydration flash)
  const [intro, setIntro] = useState<"pending" | "show" | "done">("pending");
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    // ui-system-FIXES #2: the opening sequence plays ONCE per session.
    setIntro(introDone() ? "done" : "show");
  }, []);

  const finishIntro = () => {
    markIntroDone();
    setIntro("done");
  };

  const handleCreate = async (alias: string, consent: Parameters<typeof room.createRoom>[1]) => {
    setJoining(true);
    try {
      return await room.createRoom(alias, consent);
    } finally {
      setJoining(false);
    }
  };

  const handleJoin = async (code: Parameters<typeof room.joinRoom>[0], alias: string, consent: Parameters<typeof room.createRoom>[1]) => {
    setJoining(true);
    try {
      return await room.joinRoom(code, alias, consent);
    } finally {
      setJoining(false);
    }
  };

  if (intro === "pending") {
    // Nothing to paint yet — the ambient background is already up.
    return <main className="screen" aria-busy="true" />;
  }

  if (intro === "show") {
    return <OpeningSequence onComplete={finishIntro} />;
  }

  const view = room.view;
  const inRoom = Boolean(view);

  return (
    <>
      <AnimatePresence mode="wait">
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
              onCreate={handleCreate}
              onJoin={handleJoin}
            />
          </motion.div>
        ) : view!.phase === "lobby" ? (
          <motion.div key="lobby" variants={pageVariants} initial="initial" animate="animate" exit="exit">
            <LobbyScreen
              view={view!}
              you={room.you}
              code={room.code}
              isHost={room.isHost}
              mode={room.mode}
              busy={joining}
              onStart={room.start}
              onAddBot={room.addBot}
              onCustomPrompts={room.setCustomPrompts}
              onDelete={room.deleteRoom}
              onHeatDown={room.voteHeatDown}
            />
          </motion.div>
        ) : view!.phase === "closed" ? (
          <motion.div key="closed" variants={pageVariants} initial="initial" animate="animate" exit="exit">
            <ClosedScreen
              message={room.error ?? "That's the night. The room is closed."}
              onNew={room.reset}
            />
          </motion.div>
        ) : (
          <motion.div key="play" variants={pageVariants} initial="initial" animate="animate" exit="exit">
            <PlayScreen room={room} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Reconnect handling is global: it can hit any screen, any phase. */}
      <ConnectionLostOverlay connected={room.connected} resuming={room.resuming} onRetry={room.retry} />
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
        <GlassCard className="mt-2 p-5 w-full max-w-sm">
          <p className="text-sm text-white/60 mb-3">
            The server isn&apos;t answering. It may have gone to sleep, or you&apos;re
            off the WiFi.
          </p>
          <GlowButton variant="accent" className="w-full" onClick={onGiveUp}>
            Start over
          </GlowButton>
        </GlassCard>
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

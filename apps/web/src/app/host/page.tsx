"use client";
// app/host/page.tsx — THE LAPTOP PAGE.
//
// The room is bound at startup, so the laptop opens /host?token=… and is
// already in tonight's room. No code is typed anywhere.
import { useEffect, useState } from "react";
import { HostScreen } from "@/components/HostScreen";
import { useRoom } from "@/lib/useRoom";
import { ConnectionLostOverlay } from "@/components/ConnectionLostOverlay";

export default function HostPage() {
  const room = useRoom();
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("token");
    if (!value) {
      setError("This host link is missing its token. Reopen the link the terminal printed.");
      return;
    }
    setToken(value);
    void room.bindHost(value).then((reply) => {
      if (!reply.ok) setError(reply.error ?? "That host link is not valid.");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <main className="screen flex min-h-[100dvh] flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="font-display text-heading text-center">This host link will not open</h1>
        <p className="max-w-sm text-sm text-white/60">{error}</p>
        <p className="max-w-sm text-xs text-white/35">
          Run <span className="text-white/60">npm run host</span> and open the HOST link it prints.
        </p>
      </main>
    );
  }

  return (
    <>
      <HostScreen
        view={room.view}
        finale={room.finale}
        onStart={room.start}
        onForceResults={room.forceResults}
        onSkipRound={room.skipRound}
        onDelete={room.deleteRoom}
      />
      <ConnectionLostOverlay connected={room.connected} resuming={room.resuming} hasSession={room.hasSession} onRetry={room.retry} />
    </>
  );
}

"use client";
// Intro is the first screen. The room client and later stages are loaded only
// after it completes (or immediately when this tab has already seen it).
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { introDone, markIntroDone } from "@/lib/session";
import { OpeningSequence } from "@/components/OpeningSequence";

const RoomApp = dynamic(() => import("@/components/RoomApp").then((m) => m.RoomApp), {
  loading: () => <main className="screen flex items-center justify-center" aria-busy="true">Finding your room…</main>,
});

export default function PlayPage() {
  const [intro, setIntro] = useState<"pending" | "show" | "done">("pending");
  useEffect(() => { setIntro(introDone() ? "done" : "show"); }, []);
  const finishIntro = () => { markIntroDone(); setIntro("done"); };

  if (intro === "pending") return <main className="screen" aria-busy="true" />;
  if (intro === "show") return <OpeningSequence onComplete={finishIntro} />;
  return <RoomApp />;
}

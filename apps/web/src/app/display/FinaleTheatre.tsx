"use client";

import { useCallback, useEffect, useState } from "react";
import type { FinaleView, RevealView } from "@shared/contracts.ts";

/** The public display's existing round-reveal treatment, shared by both modes. */
export function DisplayReveal({ reveal }: { reveal: RevealView }) {
  return <section className="glass-card mx-auto max-w-4xl p-10 text-center"><p className="text-sm uppercase tracking-[0.3em] text-lime-accent">Round reveal</p><h2 className="mt-3 text-3xl font-bold">{reveal.summary}</h2><div className="mt-6 space-y-3">{reveal.items?.map((item, i) => <p key={i} className="text-xl text-white/80"><strong>{item.alias}</strong> · {item.text}</p>)}</div></section>;
}

/** The public display's existing finale slides; no phone finale or private deck. */
export function DisplayFinale({ view }: { view: FinaleView }) {
  return <section className="mx-auto max-w-5xl space-y-8 text-center"><p className="text-xs uppercase tracking-[0.35em] text-lime-accent">The Reveal</p>{view.slides.map((slide, i) => <article key={`${slide.beat}-${i}`} className="glass-card p-8"><h2 className="text-3xl font-bold">{slide.title}</h2>{slide.body && <p className="mt-4 text-xl text-white/75">{slide.body}</p>}</article>)}</section>;
}

/**
 * A host-controlled stage over the ordered, public round reveals. There are no
 * timers, animated transitions, or confetti: every step is instant, including
 * when prefers-reduced-motion is enabled. `holdMs` belongs to live reveals and
 * deliberately does not pace this sequence.
 */
export function FinaleTheatre({ reveals, finale }: { reveals: readonly RevealView[]; finale: FinaleView | null }) {
  const [index, setIndex] = useState(0);
  const showingReveal = index < reveals.length;
  const advance = useCallback(() => {
    setIndex(current => Math.min(current + 1, reveals.length));
    // A long reveal can leave the stage scrolled down; the next beat starts at
    // its heading, without a smooth-scroll animation in reduced-motion mode.
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [reveals.length]);

  useEffect(() => {
    if (!showingReveal) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (typeof target?.closest === "function" && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      if (event.key !== "ArrowRight" && event.key !== "ArrowDown") return;
      event.preventDefault();
      advance();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, showingReveal]);

  if (!showingReveal) return finale ? <DisplayFinale view={finale} /> : (
    <section className="glass-card mx-auto max-w-4xl p-10 text-center" role="status">The finale is being assembled…</section>
  );

  return <div className="mx-auto w-full max-w-5xl" data-testid="finale-theatre">
    <div aria-live="polite" aria-atomic="true">
      <p className="mb-5 text-center text-sm font-bold uppercase tracking-[0.25em] text-white/70">Reveal {index + 1} / {reveals.length}</p>
      <DisplayReveal reveal={reveals[index]!} />
    </div>
    <div className="sticky bottom-4 z-10 mx-auto mt-8 flex w-full max-w-sm flex-col items-center gap-2 rounded-3xl bg-[#100019]/95 p-4 text-center">
      <button type="button" onClick={advance} aria-label={index === reveals.length - 1 ? "Next: show the finale" : "Next reveal"}
        className="min-h-[72px] w-full rounded-2xl bg-lime-accent px-8 py-4 text-2xl font-black uppercase tracking-[0.18em] text-black focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-4 focus-visible:outline-white">
        Next <span aria-hidden="true">→</span>
      </button>
      <p className="text-xs font-medium text-white/70">Tap Next or press the right arrow</p>
    </div>
  </div>;
}

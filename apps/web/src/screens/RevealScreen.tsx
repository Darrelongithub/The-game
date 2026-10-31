'use client';
// screens/RevealScreen.tsx — the round's payoff.
//
// Live moments (ROUND 3) get their own treatment:
//   spotlight → CaptionWall: captions stack, then the subject's decoy answer
//               lands last and biggest (the punchline).
//   verdict   → the Group Announcement mini-finale: anonymous vote bars fill one
//               per vote, numbers count up, then the room's answer LANDS with
//               haptics (and confetti only for couple-coded verdicts).
// Everything else keeps the generic list reveal.
import React from 'react';
import { useEffect, useRef } from 'react';
import type { RevealView } from '../../../../packages/shared/src/contracts';
import { AnimatedWords, GlassCard } from './primitives';
import { CaptionWall } from '../components/CaptionWall';
import { ConfessReveal } from '../components/ConfessReveal';
import { GroupAnnouncement } from '../components/GroupAnnouncement';

export function RevealScreen({ reveal, onComplete }: { reveal: RevealView; onComplete: () => void }) {
  const complete = useRef(onComplete); complete.current = onComplete;
  useEffect(() => { const id = window.setTimeout(() => complete.current(), Math.max(0, reveal.holdMs)); return () => window.clearTimeout(id); }, [reveal.roundId, reveal.holdMs]);
  if (reveal.kind === 'spotlight' && reveal.subject) {
    return <CaptionWall subject={reveal.subject} captions={reveal.items ?? []} {...(reveal.punchline ? { punchline: reveal.punchline } : {})} />;
  }
  if (reveal.confess) {
    return <ConfessReveal confess={reveal.confess} />;
  }
  if (reveal.kind === 'verdict' && reveal.slide) {
    return <main className="mx-auto flex min-h-[100dvh] max-w-2xl flex-col justify-center px-4 py-8 text-white"><GroupAnnouncement slide={reveal.slide} celebrate={reveal.celebrate !== false} /><p className="mt-6 text-center text-[11px] uppercase tracking-[0.25em] text-white/35">anonymous votes · counts only</p></main>;
  }
  return <main className="mx-auto min-h-[100dvh] max-w-2xl px-4 py-8 text-white"><p className="text-xs font-bold uppercase tracking-[.2em] text-lime-accent">The reveal</p><h1 className="mt-4 font-bold" style={{ fontSize: 'clamp(1.8rem, 7vw, 3.5rem)' }}><AnimatedWords text={reveal.summary}/></h1><div className="mt-6 grid gap-3">{reveal.items?.map((item, index) => <GlassCard key={`${index}-${item.alias}`}><p className="text-sm font-bold text-lime-accent">{item.alias}</p><p className="mt-2 whitespace-pre-wrap break-words">{item.text}</p></GlassCard>)}</div></main>;
}

'use client';
import React from 'react';
import { useEffect, useRef } from 'react';
import type { RevealView } from '../../../../packages/shared/src/contracts';
import { AnimatedWords, GlassCard } from './primitives';

export function RevealScreen({ reveal, onComplete }: { reveal: RevealView; onComplete: () => void }) {
  const complete = useRef(onComplete); complete.current = onComplete;
  useEffect(() => { const id = window.setTimeout(() => complete.current(), Math.max(0, reveal.holdMs)); return () => window.clearTimeout(id); }, [reveal.roundId, reveal.holdMs]);
  return <main className="mx-auto min-h-[100dvh] max-w-2xl px-4 py-8 text-white"><p className="text-xs font-bold uppercase tracking-[.2em] text-lime-accent">The reveal</p><h1 className="mt-4 font-bold" style={{ fontSize: 'clamp(1.8rem, 7vw, 3.5rem)' }}><AnimatedWords text={reveal.summary}/></h1><div className="mt-6 grid gap-3">{reveal.items?.map((item, index) => <GlassCard key={`${index}-${item.alias}`}><p className="text-sm font-bold text-lime-accent">{item.alias}</p><p className="mt-2 whitespace-pre-wrap break-words">{item.text}</p></GlassCard>)}</div></main>;
}

'use client';
import React from 'react';
import { useEffect, useRef } from 'react';
import type { InterludeView } from '../../../../packages/shared/src/contracts';
import { AnimatedWords, GlassCard } from './primitives';

export function InterludeScreen({ interlude, onComplete }: { interlude: InterludeView; onComplete: () => void }) {
  const complete = useRef(onComplete); complete.current = onComplete;
  useEffect(() => { const id = window.setTimeout(() => complete.current(), Math.max(0, interlude.holdMs)); return () => window.clearTimeout(id); }, [interlude.headline, interlude.sub, interlude.teaser, interlude.holdMs]);
  return <main className="mx-auto flex min-h-[100dvh] max-w-2xl flex-col justify-center gap-5 px-4 py-8 text-white"><h1 className="font-bold" style={{ fontSize: 'clamp(1.8rem, 7vw, 3.5rem)' }}><AnimatedWords text={interlude.headline}/></h1><p className="text-lg text-white/70">{interlude.sub}</p>{interlude.teaser && <GlassCard className="border-l-4 border-l-lime-accent"><span className="text-xs font-bold uppercase tracking-[.2em] text-lime-accent">Data drop</span><p className="mt-2 break-words">{interlude.teaser}</p></GlassCard>}</main>;
}

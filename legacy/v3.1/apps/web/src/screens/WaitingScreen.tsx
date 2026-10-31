'use client';
import React from 'react';
import type { PlayerId, RoomView } from '../../../../packages/shared/src/contracts';
import { GlassCard } from './primitives';

export interface WaitingScreenProps { room: RoomView; submittedPlayerIds?: PlayerId[]; you?: PlayerId }
export function WaitingScreen({ room, submittedPlayerIds, you }: WaitingScreenProps) {
  const submitted = new Set(submittedPlayerIds ?? (room.round?.youSubmitted && you ? [you] : []));
  return <main className="mx-auto min-h-[100dvh] max-w-2xl px-4 py-8 text-white"><h1 className="font-bold" style={{ fontSize: 'clamp(1.8rem, 7vw, 3.5rem)' }}>You're in — waiting.</h1><p className="mt-2 text-white/70">Waiting for the room to finish.</p><GlassCard className="mt-6"><ul className="grid grid-cols-2 gap-4 min-[400px]:grid-cols-3">{room.players.map(p => <li key={p.id} className="flex min-w-0 items-center gap-2"><span className={`grid h-12 w-12 shrink-0 place-items-center rounded-full border-2 font-bold ${submitted.has(p.id) ? 'border-lime-accent bg-lime-accent text-black' : 'border-white/30 bg-white/5'}`} aria-label={submitted.has(p.id) ? 'Submitted' : 'Submission status unknown or waiting'}>{p.alias.trim().split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase()}</span><span className="break-words">{p.alias}</span></li>)}</ul>{!submittedPlayerIds && <p className="mt-4 text-sm text-white/60">Other players' submission status isn't available yet.</p>}</GlassCard></main>;
}

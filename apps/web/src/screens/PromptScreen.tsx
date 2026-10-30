'use client';
import React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayerId, ResponseValue, RoomView, RoundView, TraitId } from '../../../../packages/shared/src/contracts';
import { SPOTLIGHT_ANSWER_MAX } from '../../../../packages/shared/src/contracts';
import { AnimatedWords, GlassCard, GlowButton } from './primitives';

export interface PromptScreenProps {
  round: RoundView;
  room: RoomView;
  you: PlayerId;
  /** Resolve false or reject on a failed submission so the player can retry. */
  onSubmit: (value: ResponseValue) => void | boolean | Promise<void | boolean>;
  onVoteHeatDown?: () => void;
}
const heat: Record<string, string> = { warmup: '#3b82f6', spicy: '#b6ff3c', deep: '#8b2fe0', dare: '#ff4d6d', debrief: '#ff4d6d' };
const traits: TraitId[] = ['loyalty', 'chaos', 'reliability', 'warmth', 'honesty', 'spice'];
const field = 'w-full rounded-2xl border border-white/20 bg-white/5 p-4 text-base text-white placeholder:text-white/50 focus:outline focus:outline-2 focus:outline-lime-accent';

function useRemaining(deadline: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!deadline) return; // no deadline → no ticking (most rounds have no clock)
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [deadline]);
  return deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;
}
function Clock({ seconds, total }: { seconds: number; total: number }) {
  const progress = Math.max(0, Math.min(1, seconds / total));
  return <div className="relative grid h-20 w-20 shrink-0 place-items-center" role="timer" aria-label={`${seconds} seconds remaining`}>
    <svg viewBox="0 0 80 80" className="absolute inset-0 h-full w-full" aria-hidden="true"><circle cx="40" cy="40" r="35" fill="none" stroke="rgba(255,255,255,.16)" strokeWidth="4"/><circle cx="40" cy="40" r="35" fill="none" stroke="currentColor" strokeWidth="4" strokeDasharray={`${progress * 220} 220`} transform="rotate(-90 40 40)"/></svg><span className="font-bold">{seconds}s</span>
  </div>;
}

export function PromptScreen(props: PromptScreenProps) {
  return <PromptRound key={props.round.roundId} {...props} />;
}
function PromptRound({ round, room, you, onSubmit, onVoteHeatDown }: PromptScreenProps) {
  const [submitted, setSubmitted] = useState(round.youSubmitted);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [reasonOpen, setReasonOpen] = useState(false);
  const [rating, setRating] = useState(5);
  const [ios, setIos] = useState(1);
  // The frozen RoundView has no structured trait/target. Do not silently
  // record loyalty/self when the question asked about something else.
  const [trait, setTrait] = useState<TraitId | ''>('');
  const [about, setAbout] = useState('');
  const [taps, setTaps] = useState(0);
  const [voted, setVoted] = useState(false);
  const [tapDeadline] = useState(() => Math.min(Date.now() + 5000, round.closesAt));
  const seconds = useRemaining(round.kind === 'minigame' ? tapDeadline : round.kind === 'pair_dare' ? round.closesAt - 30000 : round.closesAt);
  // LIVE MOMENTS (ROUND 3). A verdict is a debate first and a secret vote last;
  // a spotlight subject may get an idle cover screen with nothing to answer.
  const debateSeconds = useRemaining(round.voteOpensAt ?? 0);
  const votingOpen = round.kind !== 'verdict' || debateSeconds === 0;
  const idleCover = round.expectsAnswer === false;
  const latest = useRef({ text, taps }); latest.current = { text, taps };
  const locked = useRef(round.youSubmitted);
  useEffect(() => { if (round.youSubmitted) { locked.current = true; setSubmitted(true); } }, [round.youSubmitted]);
  const submit = useCallback(async (value: ResponseValue) => {
    if (locked.current) return;
    locked.current = true; setSubmitted(true); setError('');
    try { if (await onSubmit(value) === false) throw new Error('Submission was not accepted.'); }
    catch { locked.current = false; setSubmitted(false); setError('Could not submit. Please try again.'); }
  }, [onSubmit]);
  const autoAttempted = useRef(false);
  useEffect(() => {
    if (seconds !== 0 || autoAttempted.current || round.youSubmitted) return;
    if (round.kind === 'shout') { autoAttempted.current = true; void submit({ kind: 'shout', word: latest.current.text.trim() || 'Pass' }); }
    if (round.kind === 'minigame') { autoAttempted.current = true; void submit({ kind: 'minigame', score: Math.min(999, latest.current.taps) }); }
  }, [seconds, round.kind, round.youSubmitted, submit]);
  const others = room.players.filter(p => p.id !== you);
  const participant = !round.onlyPlayers || round.onlyPlayers.includes(you);
  const color = heat[round.phase] || heat.warmup;
  const showVote = ['spicy', 'deep', 'dare', 'debrief'].includes(round.phase) && onVoteHeatDown;
  return <main className="mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col gap-6 px-4 py-8 text-white" style={{ color: '#f5f3ff' }}>
    <header className="flex items-center justify-between gap-3"><span className="text-xs font-bold uppercase tracking-[.2em]" style={{ color }}>{round.phase} · Round {round.index}</span>{showVote && <button type="button" className="min-h-[48px] rounded-xl px-3 text-sm text-white/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-accent" disabled={voted} onClick={() => { onVoteHeatDown(); setVoted(true); }}>{voted ? '✓ Vote to cool sent' : 'Too hot? Cool it.'}</button>}</header>
    <h1 className="text-display-lg font-bold leading-tight" style={{ fontSize: 'clamp(1.8rem, 7vw, 3.5rem)' }}><AnimatedWords text={round.promptText} /></h1>
    {idleCover ? <GlassCard data-testid="idle-cover"><p className="text-xl font-bold">Nothing for you right now.</p><p className="mt-2 text-sm text-white/60">Soak it in. The room is busy without you.</p></GlassCard> : !participant && (round.kind === 'pair_dare' || round.kind === 'debrief') ? <GlassCard><p>They're talking…</p><p className="mt-2 text-sm text-white/60">Sit tight while the pair returns.</p></GlassCard> : submitted ? <GlassCard role="status"><p className="text-xl font-bold">You're in — waiting.</p></GlassCard> : <>
      {error && <p role="alert" className="text-red-300">{error}</p>}
      {round.kind === 'pick' && <div className="grid grid-cols-2 gap-3">{others.map(p => <GlowButton key={p.id} onClick={() => void submit({ kind: 'pick', target: p.id })}>{p.alias}</GlowButton>)}</div>}
      {(round.kind === 'text' || round.kind === 'debrief' || round.kind === 'spotlight') && (() => {
        const max = round.kind === 'spotlight' ? SPOTLIGHT_ANSWER_MAX : 280;
        return <><label htmlFor="answer" className="sr-only">Your {round.kind === 'debrief' ? 'private ' : ''}answer</label><textarea id="answer" className={`${field} ${round.kind === 'spotlight' ? 'min-h-24' : 'min-h-36'}`} maxLength={max} value={text} onChange={e => setText(e.target.value)} placeholder="Your answer…"/><div className="flex items-center justify-between gap-3"><span className="text-sm text-white/60">{text.length}/{max}</span><GlowButton disabled={!text.trim()} onClick={() => void submit({ kind: 'text', text: text.trim() })}>Submit</GlowButton></div></>;
      })()}
      {round.kind === 'shout' && <><div className="flex items-center gap-4"><label htmlFor="shout" className="sr-only">Your word</label><input id="shout" className={`${field} min-w-0 font-bold`} style={{ fontSize: 'clamp(1.5rem, 6vw, 2.5rem)' }} maxLength={24} value={text} onChange={e => setText(e.target.value.replace(/\s/g, ''))} placeholder="ONE WORD"/><Clock seconds={seconds} total={15}/></div><GlowButton disabled={!text.trim()} onClick={() => void submit({ kind: 'shout', word: text.trim() })}>Shout it</GlowButton>{seconds === 0 && <GlowButton onClick={() => void submit({ kind: 'shout', word: text.trim() || 'Pass' })}>Retry submission</GlowButton>}</>}
      {round.kind === 'rating' && <GlassCard className="space-y-5"><label className="block">Trait — match the question<select className={`${field} mt-2`} value={trait} onChange={e => setTrait(e.target.value as TraitId | '')}><option className="text-black" value="">Choose a trait</option>{traits.map(t => <option className="text-black" key={t} value={t}>{t}</option>)}</select></label><label className="block">About — match the question<select className={`${field} mt-2`} value={about} onChange={e => setAbout(e.target.value)}><option className="text-black" value="">Choose who</option><option className="text-black" value="self">Myself</option>{others.map(p => <option className="text-black" key={p.id} value={p.id}>{p.alias}</option>)}</select></label><label className="block">Rating: {rating}/10<input className="mt-3 min-h-[48px] w-full accent-lime-accent" type="range" min={1} max={10} value={rating} onChange={e => setRating(Number(e.target.value))}/></label><GlowButton disabled={!trait || !about} onClick={() => { if (trait && about) void submit({ kind: 'rating', trait, about, value: rating }); }}>Submit rating</GlowButton></GlassCard>}
      {round.kind === 'ios' && <GlassCard><label className="block">About<select className={`${field} mt-2`} value={about === 'self' ? '' : about} onChange={e => setAbout(e.target.value)}><option className="text-black" value="">Choose a player</option>{others.map(p => <option className="text-black" key={p.id} value={p.id}>{p.alias}</option>)}</select></label><fieldset className="mt-5"><legend>How close are you?</legend><div className="mt-3 grid grid-cols-2 gap-2 min-[400px]:grid-cols-4">{Array.from({ length: 7 }, (_, i) => <button type="button" key={i} aria-pressed={ios === i + 1} aria-label={`Closeness ${i + 1} of 7`} onClick={() => setIos(i + 1)} className={`min-h-[64px] rounded-xl border focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-accent ${ios === i + 1 ? 'border-lime-accent' : 'border-white/20'}`}><svg viewBox="0 0 72 40" className="mx-auto h-10 w-20 max-w-full" aria-hidden="true"><circle cx={20 + i * 1.8} cy="20" r="15" fill="#8b2fe0" fillOpacity=".65" stroke="white"/><circle cx={52 - i * 1.8} cy="20" r="15" fill="#b6ff3c" fillOpacity=".5" stroke="white"/></svg><span className="text-xs">{i + 1}</span></button>)}</div></fieldset><GlowButton className="mt-5" disabled={about === 'self' || !about} onClick={() => void submit({ kind: 'ios', about, value: ios })}>Submit closeness</GlowButton></GlassCard>}
      {round.kind === 'minigame' && <GlassCard className="text-center"><Clock seconds={seconds} total={5}/><p className="my-4 text-3xl font-bold" aria-live="polite">{taps} taps</p><GlowButton className="min-h-32 w-full text-2xl" disabled={seconds === 0} onClick={() => setTaps(n => Math.min(999, n + 1))}>TAP!</GlowButton>{seconds === 0 && <GlowButton className="mt-4" onClick={() => void submit({ kind: 'minigame', score: taps })}>Submit score</GlowButton>}</GlassCard>}
      {round.kind === 'verdict' && (votingOpen
        ? <div data-testid="verdict-pickgrid" className="grid grid-cols-2 gap-3">{others.map(p => <GlowButton key={p.id} onClick={() => void submit({ kind: 'pick', target: p.id })}>{p.alias}</GlowButton>)}</div>
        : <GlassCard data-testid="verdict-debate" className="text-center"><p className="font-display font-bold uppercase tracking-[0.14em]" style={{ fontSize: 'clamp(1.1rem, 5vw, 1.6rem)', color: 'var(--red-alert)' }}>Phones down. Argue it out.</p><p className="mt-4 tabular-nums font-display" style={{ fontSize: 'clamp(2.4rem, 12vw, 4rem)' }} aria-live="polite">{debateSeconds}s</p><p className="mt-2 text-sm text-white/55">The vote opens when this hits zero. Nobody sees your pick.</p></GlassCard>)}
      {round.kind === 'dare' && <><GlowButton onClick={() => void submit({ kind: 'dare', status: 'done' })}>Done</GlowButton><GlowButton className="border border-lime-accent/50 bg-none" onClick={() => setReasonOpen(true)}>I can't</GlowButton>{reasonOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-labelledby="reason-title" onKeyDown={e => { if (e.key === 'Escape') setReasonOpen(false); }}><GlassCard className="w-full max-w-md bg-[#0d0617]"><h2 id="reason-title" className="text-xl font-bold">Why can't you?</h2><label htmlFor="reason" className="mt-3 block">A reason is required.</label><textarea autoFocus id="reason" maxLength={140} value={reason} onChange={e => setReason(e.target.value)} className={`${field} mt-2 min-h-28`}/><p className="text-sm text-white/60">{reason.length}/140</p><div className="mt-4 flex flex-wrap gap-2"><GlowButton disabled={!reason.trim()} onClick={() => void submit({ kind: 'dare', status: 'passed', reason: reason.trim() })}>Pass dare</GlowButton><GlowButton onClick={() => setReasonOpen(false)}>Cancel</GlowButton></div></GlassCard></div>}</>}
      {round.kind === 'pair_dare' && <GlassCard><p className="text-xl font-bold">Go talk together.</p><p className="mt-2 text-white/70">You have five minutes. Come back when you're ready.</p><div className="my-4"><Clock seconds={seconds} total={300}/></div><GlowButton onClick={() => void submit({ kind: 'dare', status: 'done' })}>We're back</GlowButton></GlassCard>}
    </>}
  </main>;
}

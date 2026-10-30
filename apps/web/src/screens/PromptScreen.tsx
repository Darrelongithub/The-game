'use client';
import React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayerId, ResponseValue, RoomView, RoundView } from '../../../../packages/shared/src/contracts';
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
const heat: Record<string, string> = { warmup: '#dfa7ff', spicy: '#f4a8e8', deep: '#ce9bff', dare: '#ff8aaa', debrief: '#ff8aaa' };
const field = 'w-full rounded-2xl border border-white/20 bg-white/5 p-4 text-base text-white placeholder:text-white/50 focus:outline focus:outline-2 focus:outline-lime-accent';

// Rating/IOS intent comes from the authoritative RoundView field. Missing
// assignments never expose a guessed trait/target control.
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const callbackMarker = '\n\nEarlier, someone said: “';
function splitCallback(text: string): { question: string; callback?: string } {
  const index = text.indexOf(callbackMarker);
  if (index < 0) return { question: text };
  return { question: text.slice(0, index), callback: `“${text.slice(index + callbackMarker.length)}` };
}

function displayPrompt(round: RoundView, room: RoomView, you: PlayerId): string {
  if (round.kind !== 'ios') return round.promptText;
  const ownAlias = room.players.find((player) => player.id === you)?.alias;
  if (!ownAlias) return round.promptText;
  const selfReference = new RegExp(`(\\b(?:you\\s+and|with)\\s+)${escapeRegExp(ownAlias)}(?=$|[^\\p{L}\\p{N}])`, 'iu');
  // A shared named prompt may name the person reading it. IOS cannot target
  // yourself, so ask that person to choose someone else instead.
  return round.promptText.replace(selfReference, '$1someone here');
}

// Only the small timer component updates on the clock; the question and input
// controls no longer rerender five times a second on every player's phone.
function useRemaining(deadline: number) {
  const [seconds, setSeconds] = useState(() => Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
  useEffect(() => {
    const update = () => setSeconds(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    update();
    const id = window.setInterval(update, 250);
    return () => window.clearInterval(id);
  }, [deadline]);
  return seconds;
}
function Clock({ deadline, total }: { deadline: number; total: number }) {
  const seconds = useRemaining(deadline);
  const progress = Math.max(0, Math.min(1, seconds / total));
  return <div className="relative grid h-20 w-20 shrink-0 place-items-center" role="timer" aria-label={`${seconds} seconds remaining`}>
    <svg viewBox="0 0 80 80" className="absolute inset-0 h-full w-full" aria-hidden="true">
      <circle cx="40" cy="40" r="35" fill="none" stroke="rgba(255,255,255,.16)" strokeWidth="4"/>
      <circle cx="40" cy="40" r="35" fill="none" stroke="currentColor" strokeWidth="4" strokeDasharray={`${progress * 220} 220`} transform="rotate(-90 40 40)"/>
    </svg><span className="font-bold tabular-nums">{seconds}s</span>
  </div>;
}
function RemainingLabel({ deadline }: { deadline: number }) {
  const seconds = useRemaining(deadline);
  return <span role="timer" className="text-xs tabular-nums text-white/65">{seconds ? `${seconds}s left` : 'Finishing the round…'}</span>;
}
function DebateTimer({ deadline }: { deadline: number }) {
  const seconds = useRemaining(deadline);
  return <p className="mt-4 tabular-nums font-display" style={{ fontSize: 'clamp(2.4rem, 12vw, 4rem)' }} aria-live="polite">{seconds}s</p>;
}
/** Only rerender the question when voting actually opens, not on every tick. */
function useDeadlineReached(deadline: number) {
  const [reached, setReached] = useState(() => !deadline || Date.now() >= deadline);
  useEffect(() => {
    const remaining = deadline - Date.now();
    setReached(!deadline || remaining <= 0);
    if (!deadline || remaining <= 0) return;
    const timer = window.setTimeout(() => setReached(true), remaining);
    return () => window.clearTimeout(timer);
  }, [deadline]);
  return reached;
}

export function PromptScreen(props: PromptScreenProps) {
  return <PromptRound key={props.round.roundId} {...props} />;
}
function PromptRound({ round, room, you, onSubmit, onVoteHeatDown }: PromptScreenProps) {
  const { question, callback } = splitCallback(round.promptText);
  const questionRound = { ...round, promptText: question };
  const [submitted, setSubmitted] = useState(round.youSubmitted);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [reasonOpen, setReasonOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const [rating, setRating] = useState(5);
  const [ios, setIos] = useState(0);
  const trait = round.trait ?? '';
  const about = round.about ?? '';

  // CONFESS: yes / no about YOURSELF. No skip — the timer takes "unanswered".
  const [confessYes, setConfessYes] = useState<boolean | null>(null);
  const [confessNote, setConfessNote] = useState('');
  const [taps, setTaps] = useState(0);
  const [voted, setVoted] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [tapDeadline] = useState(() => Math.min(Date.now() + 5000, round.closesAt));
  const votingOpen = useDeadlineReached(round.kind === 'verdict' ? round.voteOpensAt ?? 0 : 0);
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
    if (round.kind !== 'shout' && round.kind !== 'minigame') return;
    const deadline = round.kind === 'minigame' ? tapDeadline : round.closesAt;
    const id = window.setTimeout(() => {
      setTimedOut(true);
      if (autoAttempted.current || locked.current) return;
      autoAttempted.current = true;
      if (round.kind === 'shout') void submit({ kind: 'shout', word: latest.current.text.trim() || 'Pass' });
      else void submit({ kind: 'minigame', score: Math.min(999, latest.current.taps) });
    }, Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(id);
  }, [round.kind, round.closesAt, tapDeadline, submit]);

  const others = room.players.filter(p => p.id !== you);
  const participant = (!round.onlyPlayers || round.onlyPlayers.includes(you)) && (!round.performer || round.performer === you);
  const color = heat[round.phase] || heat.warmup;
  const showVote = ['spicy', 'deep', 'dare', 'debrief'].includes(round.phase) && onVoteHeatDown;
  return <main className="mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col gap-6 px-4 pt-8 pb-28 text-white" style={{ color: '#f5f3ff' }}>
    <header className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-xs font-bold uppercase tracking-[.2em]" style={{ color }}>{round.phase} · Round {round.index}</span>
      <div className="flex items-center gap-3">
        {!['shout', 'minigame', 'pair_dare'].includes(round.kind) && <RemainingLabel deadline={round.closesAt} />}
        {showVote && <button type="button" className="min-h-[48px] rounded-xl px-3 text-sm text-white/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-accent" disabled={voted} onClick={() => { onVoteHeatDown(); setVoted(true); }}>{voted ? '✓ Vote to cool sent' : 'Too hot? Cool it.'}</button>}
      </div>
    </header>
    <h1 className="text-display-lg font-bold leading-tight" style={{ fontSize: 'clamp(1.8rem, 7vw, 3.5rem)' }}><AnimatedWords text={displayPrompt(questionRound, room, you)} /></h1>
    {callback && <p data-testid="callback-note" className="rounded-2xl border border-white/15 bg-white/5 px-4 py-3 text-sm leading-relaxed text-white/75"><span className="text-white/50">Earlier, someone said: </span>{callback}</p>}
    {idleCover ? <GlassCard data-testid="idle-cover"><p className="text-xl font-bold">Nothing for you right now.</p><p className="mt-2 text-sm text-white/60">Soak it in. The room is busy without you.</p></GlassCard> : !participant ? <GlassCard><p>{round.kind === 'dare' ? `${room.players.find(p => p.id === round.performer)?.alias ?? 'The performer'} is up.` : round.kind === 'pair_dare' || round.kind === 'debrief' ? "They’re talking…" : "You’re spectating this round."}</p><p className="mt-2 text-sm text-white/60">You’ll rejoin the room after this beat.</p></GlassCard> : submitted ? <GlassCard role="status"><p className="text-xl font-bold">Answer sent.</p><p className="mt-2 text-sm text-white/70">Waiting for everyone else. The next question comes when they finish or the timer runs out.</p></GlassCard> : <>
      {error && <p role="alert" className="text-red-300">{error}</p>}
      {round.kind === 'pick' && <div className="answer-arrival space-y-4">
        <p className="text-sm text-white/70">Choose one person, then lock in your answer.</p>
        <div className="grid grid-cols-2 gap-3">{others.map(p => <GlowButton key={p.id} aria-pressed={selected === p.id} onClick={() => setSelected(p.id)} className={selected === p.id ? 'ring-2 ring-white ring-offset-2 ring-offset-[#100019]' : 'opacity-80'}>{p.alias}</GlowButton>)}</div>
        <GlowButton className="w-full" disabled={!selected} onClick={() => void submit({ kind: 'pick', target: selected })}>Lock in answer</GlowButton>
      </div>}
      {(round.kind === 'text' || round.kind === 'debrief' || round.kind === 'spotlight') && (() => {
        const max = round.kind === 'spotlight' ? SPOTLIGHT_ANSWER_MAX : 280;
        return <><label htmlFor="answer" className="sr-only">Your {round.kind === 'debrief' ? 'private ' : ''}answer</label><textarea id="answer" className={`${field} ${round.kind === 'spotlight' ? 'min-h-24' : 'min-h-36'}`} maxLength={max} value={text} onChange={e => setText(e.target.value)} placeholder="Your answer…"/><div className="flex items-center justify-between gap-3"><span className="text-sm text-white/60">{text.length}/{max}</span><GlowButton disabled={!text.trim()} onClick={() => void submit({ kind: 'text', text: text.trim() })}>Submit</GlowButton></div></>;
      })()}
      {round.kind === 'shout' && <><div className="flex items-center gap-4"><label htmlFor="shout" className="sr-only">Your word</label><input id="shout" className={`${field} min-w-0 font-bold`} style={{ fontSize: 'clamp(1.5rem, 6vw, 2.5rem)' }} maxLength={24} value={text} onChange={e => setText(e.target.value.replace(/\s/g, ''))} placeholder="ONE WORD"/><Clock deadline={round.closesAt} total={15}/></div><GlowButton disabled={!text.trim()} onClick={() => void submit({ kind: 'shout', word: text.trim() })}>Shout it</GlowButton>{timedOut && <GlowButton onClick={() => void submit({ kind: 'shout', word: text.trim() || 'Pass' })}>Retry submission</GlowButton>}</>}
      {round.kind === 'rating' && trait && about && <GlassCard className="space-y-5"><p>Rate <strong>{room.players.find(p => p.id === about)?.alias}</strong> on <strong>{trait}</strong>.</p><label className="block">Rating: {rating}/10<input className="mt-3 min-h-[48px] w-full accent-lime-accent" type="range" min={1} max={10} value={rating} onChange={e => setRating(Number(e.target.value))}/></label><GlowButton onClick={() => void submit({ kind: 'rating', trait, about, value: rating })}>Submit rating</GlowButton></GlassCard>}
      {round.kind === 'ios' && about && <GlassCard><p>How close are you to <strong>{room.players.find(p => p.id === about)?.alias}</strong>?</p><fieldset className="mt-5"><legend>How close are you?</legend><div className="mt-3 grid grid-cols-2 gap-2 min-[400px]:grid-cols-4">{Array.from({ length: 7 }, (_, i) => <button type="button" key={i} aria-pressed={ios === i + 1} aria-label={`Closeness ${i + 1} of 7`} onClick={() => setIos(i + 1)} className={`min-h-[64px] rounded-xl border focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-accent ${ios === i + 1 ? 'border-lime-accent bg-white/10' : 'border-white/20'}`}><svg viewBox="0 0 72 40" className="mx-auto h-10 w-20 max-w-full" aria-hidden="true"><circle cx={20 + i * 1.8} cy="20" r="15" fill="#9f2cd4" fillOpacity=".65" stroke="white"/><circle cx={52 - i * 1.8} cy="20" r="15" fill="#efb4ff" fillOpacity=".5" stroke="white"/></svg><span className="text-xs">{i + 1}</span></button>)}</div></fieldset><GlowButton className="mt-5" onClick={() => void submit({ kind: 'ios', about, value: ios })}>Submit closeness</GlowButton></GlassCard>}
      {round.kind === 'minigame' && <GlassCard className="text-center"><div className="flex justify-center"><Clock deadline={tapDeadline} total={5}/></div><p className="my-4 text-3xl font-bold" aria-live="polite">{taps} taps</p><GlowButton className="min-h-32 w-full text-2xl" disabled={timedOut} onClick={() => setTaps(n => Math.min(999, n + 1))}>TAP!</GlowButton>{timedOut && <GlowButton className="mt-4" onClick={() => void submit({ kind: 'minigame', score: taps })}>Submit score</GlowButton>}</GlassCard>}
      {round.kind === 'verdict' && (votingOpen
        ? <div data-testid="verdict-pickgrid" className="answer-arrival space-y-4"><p className="text-sm text-white/70">Choose one person, then lock in your private vote.</p><div className="grid grid-cols-2 gap-3">{others.map(p => <GlowButton key={p.id} aria-pressed={selected === p.id} onClick={() => setSelected(p.id)} className={selected === p.id ? 'ring-2 ring-white ring-offset-2 ring-offset-[#100019]' : 'opacity-80'}>{p.alias}</GlowButton>)}</div><GlowButton className="w-full" disabled={!selected} onClick={() => void submit({ kind: 'pick', target: selected })}>Lock in answer</GlowButton></div>
        : <GlassCard data-testid="verdict-debate" className="text-center"><p className="font-display font-bold uppercase tracking-[0.14em]" style={{ fontSize: 'clamp(1.1rem, 5vw, 1.6rem)', color: 'var(--red-alert)' }}>Phones down. Argue it out.</p><DebateTimer deadline={round.voteOpensAt ?? 0}/><p className="mt-2 text-sm text-white/55">The vote opens when this hits zero. Nobody sees your pick.</p></GlassCard>)}
      {round.kind === 'confess' && <GlassCard data-testid="confess-answer" className="space-y-4">
        <p className="text-sm text-white/70">About you, not about anyone else. Only the count leaves this phone.</p>
        <div className="grid grid-cols-2 gap-3">
          <GlowButton aria-pressed={confessYes === true} onClick={() => setConfessYes(true)} className={confessYes === true ? 'ring-2 ring-white ring-offset-2 ring-offset-[#100019]' : 'opacity-80'}>Yes</GlowButton>
          <GlowButton aria-pressed={confessYes === false} onClick={() => { setConfessYes(false); setSelected(''); }} className={confessYes === false ? 'ring-2 ring-white ring-offset-2 ring-offset-[#100019]' : 'opacity-80'}>No</GlowButton>
        </div>
        {confessYes === true && <div className="space-y-3">
          <p className="text-sm text-white/70">Point at someone? Optional — and it stays private.</p>
          <div className="grid grid-cols-2 gap-3">{others.map(p => <GlowButton key={p.id} aria-pressed={selected === p.id} onClick={() => setSelected(selected === p.id ? '' : p.id)} className={selected === p.id ? 'ring-2 ring-white ring-offset-2 ring-offset-[#100019]' : 'opacity-80'}>{p.alias}</GlowButton>)}</div>
        </div>}
        <div>
          <label htmlFor="confess-note" className="text-sm text-white/70">One line, if you want one</label>
          <input id="confess-note" className={`${field} mt-2`} maxLength={140} value={confessNote} onChange={e => setConfessNote(e.target.value)} placeholder="Optional" />
        </div>
        <GlowButton className="w-full" disabled={confessYes === null} onClick={() => void submit({
          kind: 'confess', yes: confessYes === true,
          ...(confessYes === true && selected ? { target: selected } : {}),
          ...(confessNote.trim() ? { note: confessNote.trim() } : {}),
        })}>Lock in answer</GlowButton>
        <p className="text-xs text-white/45">No skip. If you leave it, the round closes without you — that is not a “no”.</p>
      </GlassCard>}
      {round.kind === 'dare' && round.performer === you && <><p className="text-sm text-white/70">Your dare. You can pass, but give a reason.</p><GlowButton onClick={() => void submit({ kind: 'dare', status: 'done' })}>Done</GlowButton></>}
      {(round.kind === 'dare' || round.kind === 'pair_dare') && <><GlowButton className="border border-lime-accent/50 bg-none" onClick={() => setReasonOpen(true)}>I can&apos;t</GlowButton>{reasonOpen && <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-labelledby="reason-title" onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') setReasonOpen(false); }}><GlassCard className="w-full max-w-md bg-[#0d0617]"><h2 id="reason-title" className="text-xl font-bold">Why can&apos;t you?</h2><label htmlFor="reason" className="mt-3 block">A reason is required.</label><textarea autoFocus id="reason" maxLength={140} value={reason} onChange={e => setReason(e.target.value)} className={`${field} mt-2 min-h-28`}/><p className="text-sm text-white/60">{reason.length}/140</p><div className="mt-4 flex flex-wrap gap-2"><GlowButton disabled={!reason.trim()} onClick={() => void submit({ kind: 'dare', status: 'passed', reason: reason.trim() })}>Pass dare</GlowButton><GlowButton onClick={() => setReasonOpen(false)}>Cancel</GlowButton></div></GlassCard></div>}</>}
      {round.kind === 'pair_dare' && <GlassCard><p className="text-xl font-bold">You two—one shared dare.</p><p className="mt-2 text-white/70">Either of you can pass. If one passes, both phones must give a reason.</p><div className="my-4"><Clock deadline={round.closesAt - 30000} total={300}/></div><GlowButton onClick={() => void submit({ kind: 'dare', status: 'done' })}>We did it</GlowButton></GlassCard>}
    </>}
  </main>;
}

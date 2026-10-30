"use client";
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { Consent, JoinReply, ProfileAnswers, RoomCode } from "@shared/contracts.ts";
import { PROFILE_QUESTIONS, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, AGE_MIN } from "@shared/contracts.ts";
import { isAlias } from "@shared/validate.ts";
import { GlassCard } from "@/components/GlassCard";
import { GlowButton } from "@/components/GlowButton";
import { AnimatedWords } from "@/components/AnimatedWords";
import { Flame } from "@/components/Flame";
import { staggerContainer, staggerItem } from "@/lib/motion";
import { clsx } from "clsx";

type Tab = "create" | "join";
type Step = "alias" | "profile" | "consent";
const sanitizeCode = (raw: string): string => [...raw.toUpperCase()].filter((c) => ROOM_CODE_ALPHABET.includes(c)).slice(0, ROOM_CODE_LENGTH).join("");
const initialProfile: ProfileAnswers = { age: 0, relationship: "single", partnersToDate: 0, longestMonths: 0, crushingHere: false, tonight: "vibes" };
const field = "field";

export function JoinScreen({ hasSession, busy, error, onCreate, onJoin }: {
  hasSession: boolean;
  busy: boolean;
  error: string | null;
  onCreate: (alias: string, consent: Consent, profile: ProfileAnswers) => Promise<JoinReply & { code?: RoomCode }>;
  onJoin: (code: RoomCode, alias: string, consent: Consent, profile: ProfileAnswers) => Promise<JoinReply>;
}) {
  const [tab, setTab] = useState<Tab>("create");
  const [step, setStep] = useState<Step>("alias");
  const [alias, setAlias] = useState("");
  const [code, setCode] = useState("");
  const [profile, setProfile] = useState<ProfileAnswers>(initialProfile);
  const [age, setAge] = useState(false);
  const [terms, setTerms] = useState(false);
  const [revealOptIn, setRevealOptIn] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    try { const saved = window.sessionStorage.getItem("reveal.alias"); if (saved) setAlias(saved); } catch { /* ignore */ }
  }, []);

  const aliasOk = isAlias(alias);
  const codeOk = code.length === ROOM_CODE_LENGTH;
  const allConsent = age && terms && revealOptIn;
  const profileComplete = Number.isInteger(profile.age) && profile.age >= AGE_MIN && profile.age <= 120 &&
    Number.isInteger(profile.partnersToDate) && profile.partnersToDate >= 0 && profile.partnersToDate <= 200 && Number.isInteger(profile.longestMonths) && profile.longestMonths >= 0 && profile.longestMonths <= 1200;
  const canContinueAlias = aliasOk && (tab === "create" || codeOk) && !busy;
  const canGo = profileComplete && allConsent && !busy;
  const consent: Consent = useMemo(() => ({ age, terms, revealOptIn }), [age, terms, revealOptIn]);
  const persistAlias = () => { try { window.sessionStorage.setItem("reveal.alias", alias.trim()); } catch { /* ignore */ } };
  const go = async () => {
    if (!canGo) return;
    setLocalError(null); persistAlias();
    const reply = tab === "create"
      ? await onCreate(alias.trim(), consent, profile)
      : await onJoin(code, alias.trim(), consent, profile);
    if (!reply.ok) setLocalError(reply.error ?? "Could not get in.");
  };
  const set = <K extends keyof ProfileAnswers>(key: K, value: ProfileAnswers[K]) => setProfile((current) => ({ ...current, [key]: value }));

  return (
    <main className="screen relative flex flex-col items-center justify-center px-5 py-10">
      <motion.div variants={staggerContainer} initial="initial" animate="animate" className="w-full max-w-md flex flex-col items-center gap-6">
        <motion.div variants={staggerItem} className="flex flex-col items-center gap-3">
          <Flame size={72} />
          <p className="text-[11px] tracking-[0.28em] uppercase text-white/50 font-medium">Private · 18+ · {AGE_MIN}+ only</p>
        </motion.div>
        <motion.div variants={staggerItem} className="w-full"><AnimatedWords text="The Reveal Game" highlightWord="Reveal" className="text-display-lg md:text-display-xl text-center" /></motion.div>
        <motion.p variants={staggerItem} className="text-center text-white/60 text-sm leading-relaxed max-w-sm">One phone each. Four to eleven friends. Answer honestly — the night keeps receipts and hands them back at the end.</motion.p>
        <motion.div variants={staggerItem} className="w-full">
          <GlassCard className="w-full p-5 md:p-6">
            <div className="mb-5 grid grid-cols-2 gap-1 rounded-2xl bg-white/5 p-1">
              {(["create", "join"] as Tab[]).map((t) => <button key={t} type="button" onClick={() => { setTab(t); setStep("alias"); }} className={clsx("min-h-[48px] rounded-xl text-sm font-medium transition-colors", tab === t ? "bg-white/12 text-white" : "text-white/55")} aria-pressed={tab === t}>{t === "create" ? "Create a room" : "Join a room"}</button>)}
            </div>
            {step === "alias" && <>
              <label className="block text-xs uppercase tracking-[0.18em] text-white/45 mb-2" htmlFor="alias">Your alias</label>
              <input id="alias" className="field mb-1" value={alias} onChange={(e) => setAlias(e.target.value.slice(0, 14))} placeholder="e.g. Wachuki" autoComplete="off" autoCapitalize="words" maxLength={14} inputMode="text" />
              <p className={clsx("text-[11px] mb-4", aliasOk || !alias ? "text-white/35" : "text-alert")}>2–14 characters. Your alias stays in this room.</p>
              {tab === "join" && <>
                <label className="block text-xs uppercase tracking-[0.18em] text-white/45 mb-2" htmlFor="code">Room code</label>
                <input id="code" className="field mb-1 text-center font-display text-2xl tracking-[0.5em] uppercase" value={code} onChange={(e) => setCode(sanitizeCode(e.target.value))} placeholder="ABCD" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={ROOM_CODE_LENGTH} inputMode="text" style={{ paddingLeft: "1.75rem" }} />
                <p className="text-[11px] text-white/35 mb-4">Four characters from the host&apos;s screen.</p>
              </>}
              <GlowButton className="w-full" disabled={!canContinueAlias} onClick={() => { setLocalError(null); setStep("profile"); }}>{busy ? "Getting you in…" : "Continue"}</GlowButton>
            </>}

            {step === "profile" && <>
              <h2 className="text-xl font-bold">A little about you</h2>
              <p className="mb-4 text-xs text-white/50">One minute. This context is used for the game, never shown raw on screen.</p>
              <div className="space-y-4">
                {PROFILE_QUESTIONS.map((question) => {
                  const key = question.field;
                  return <div key={key}>
                    <label className="mb-1 block text-sm" htmlFor={`profile-${key}`}>{question.label}</label>
                    {question.kind === "number" && <input id={`profile-${key}`} className={field} type="number" min={key === "age" ? AGE_MIN : 0} max={key === "age" ? 120 : key === "partnersToDate" ? 200 : 1200} value={key === "age" && profile.age === 0 ? "" : profile[key] as number} onChange={(e) => set(key as "age" | "partnersToDate" | "longestMonths", Number(e.target.value))} />}
                    {key === "relationship" && <select id={`profile-${key}`} className={field} value={profile.relationship} onChange={(e) => set("relationship", e.target.value as ProfileAnswers["relationship"])}>{["single", "dating", "committed", "married", "complicated"].map(value => <option className="text-black" key={value} value={value}>{value}</option>)}</select>}
                    {key === "tonight" && <select id={`profile-${key}`} className={field} value={profile.tonight} onChange={(e) => set("tonight", e.target.value as ProfileAnswers["tonight"])}>{["chaos", "vibes", "feelings", "mission"].map(value => <option className="text-black" key={value} value={value}>{value}</option>)}</select>}
                    {key === "crushingHere" && <button id={`profile-${key}`} type="button" aria-pressed={profile.crushingHere} onClick={() => set("crushingHere", !profile.crushingHere)} className="min-h-[48px] rounded-xl border border-white/20 px-4">{profile.crushingHere ? "Yes" : "No"}<span className="ml-2 text-xs text-lime-accent">Stays secret</span></button>}
                    {"secret" in question && question.secret && <p className="mt-1 text-xs text-lime-accent">Your answer stays secret.</p>}
                  </div>;
                })}
              </div>
              {profile.age < AGE_MIN && <p role="alert" className="mt-3 text-sm text-alert">This game is 18+ only. You can’t continue.</p>}
              <div className="mt-5 flex gap-3"><GlowButton className="flex-1" onClick={() => setStep("alias")}>Back</GlowButton><GlowButton className="flex-1" disabled={!profileComplete} onClick={() => { setLocalError(null); setStep("consent"); }}>Continue</GlowButton></div>
            </>}

            {step === "consent" && <>
              <h2 className="mb-4 text-xl font-bold">Before you enter</h2>
              <div className="space-y-2.5 mb-5">
                <ConsentRow checked={age} onChange={setAge} label={`I'm ${AGE_MIN} or older`} hint="This room is adults only. No exceptions." />
                <ConsentRow checked={terms} onChange={setTerms} label="I agree to the house rules" hint="Private group, nothing leaves these phones, no screenshots out." />
                <ConsentRow checked={revealOptIn} onChange={setRevealOptIn} label="I opt in to private reveal cards" hint="Secrets land on YOUR phone only, face-down, hold to open. Decline and you get none." />
              </div>
              <div className="flex gap-3"><GlowButton className="flex-1" onClick={() => setStep("profile")}>Back</GlowButton><GlowButton className="flex-1" onClick={go} disabled={!canGo}>{busy ? "Getting you in…" : tab === "create" ? "Create room" : "Join room"}</GlowButton></div>
            </>}
            {(localError || error) && <p className="mt-3 text-sm text-alert" role="alert">{localError ?? error}</p>}
            {hasSession && <p className="mt-4 text-center text-[11px] text-white/40">There&apos;s a session in this tab — it resumes automatically. Starting a new room here replaces it.</p>}
          </GlassCard>
        </motion.div>
        <motion.p variants={staggerItem} className="text-center text-[11px] text-white/30 max-w-xs leading-relaxed">Everything runs on the host&apos;s machine. Rooms die after 48 hours, and any player can delete the whole thing instantly.</motion.p>
      </motion.div>
    </main>
  );
}

function ConsentRow({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return <button type="button" onClick={() => onChange(!checked)} aria-pressed={checked} className={clsx("w-full min-h-[56px] text-left rounded-2xl border px-3.5 py-3 flex items-start gap-3 transition-colors", checked ? "border-lime-accent/50 bg-lime-accent/10" : "border-white/12 bg-white/[0.03]")}>
    <span className={clsx("mt-0.5 h-5 w-5 shrink-0 rounded-md border flex items-center justify-center text-[13px] leading-none", checked ? "border-lime-accent bg-lime-accent text-black" : "border-white/30 text-transparent")} aria-hidden>✓</span>
    <span><span className="block text-sm text-white">{label}</span><span className="block text-[11px] text-white/40 leading-snug mt-0.5">{hint}</span></span>
  </button>;
}

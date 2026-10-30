"use client";
// Room entry is a single action; the private-card preference remains optional.
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import type { Consent, JoinReply, ProfileAnswers, RoomCode } from "@shared/contracts.ts";
import { AGE_MIN, PROFILE_QUESTIONS, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "@shared/contracts.ts";
import { isAlias } from "@shared/validate.ts";
import { GlassCard } from "@/components/GlassCard";
import { GlowButton } from "@/components/GlowButton";
import { AnimatedWords } from "@/components/AnimatedWords";
import { Flame } from "@/components/Flame";
import { staggerContainer, staggerItem } from "@/lib/motion";
import { clsx } from "clsx";

type Tab = "create" | "join";

const sanitizeCode = (raw: string): string => {
  // An invite link can be pasted as well as the four-character code itself.
  let value = raw;
  try {
    if (/^https?:\/\//i.test(raw.trim())) value = new URL(raw.trim()).searchParams.get("room") ?? raw;
  } catch { /* Treat it as a plain code. */ }
  return [...value.toUpperCase()]
    .filter((c) => ROOM_CODE_ALPHABET.includes(c))
    .slice(0, ROOM_CODE_LENGTH)
    .join("");
};

export function JoinScreen({
  hasSession,
  busy,
  error,
  onCreate,
  onJoin,
}: {
  hasSession: boolean;
  busy: boolean;
  error: string | null;
  onCreate: (alias: string, consent: Consent, profile: ProfileAnswers, options?: { demo?: boolean }) => Promise<JoinReply & { code?: RoomCode }>;
  onJoin: (code: RoomCode, alias: string, consent: Consent, profile: ProfileAnswers) => Promise<JoinReply>;
}) {
  const [tab, setTab] = useState<Tab>("create");
  const [alias, setAlias] = useState("");
  const [code, setCode] = useState("");
  const [revealOptIn, setRevealOptIn] = useState(true);
  const [ageConsent, setAgeConsent] = useState(false);
  const [termsConsent, setTermsConsent] = useState(false);
  const [profile, setProfile] = useState<ProfileAnswers>({ age: 0, relationship: "single", partnersToDate: 0, longestMonths: 0, crushingHere: false, tonight: "vibes" });
  const [showPrivacyOptions, setShowPrivacyOptions] = useState(false);
  // ROUND 4: a demo room lets one host play every seat on one laptop.
  const [demoRoom, setDemoRoom] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem("reveal.alias");
      if (saved) setAlias(saved);
    } catch { /* Storage may be disabled; manual entry still works. */ }
    const invite = new URLSearchParams(window.location.search).get("room");
    if (invite) {
      setCode(sanitizeCode(invite));
      setTab("join");
    }
  }, []);

  const aliasOk = isAlias(alias);
  const profileComplete = Number.isInteger(profile.age) && profile.age >= AGE_MIN && profile.age <= 120 && Number.isInteger(profile.partnersToDate) && profile.partnersToDate >= 0 && profile.partnersToDate <= 200 && Number.isInteger(profile.longestMonths) && profile.longestMonths >= 0 && profile.longestMonths <= 1200;
  const canGo = aliasOk && profileComplete && ageConsent && termsConsent && (tab === "create" || code.length === ROOM_CODE_LENGTH) && !busy;

  const go = async () => {
    if (!canGo) return;
    setLocalError(null);
    try { window.sessionStorage.setItem("reveal.alias", alias.trim()); } catch { /* optional */ }
    // Preserve the server's required consent contract and the per-player
    // private-card opt-out without adding extra entry steps.
    const consent: Consent = { age: ageConsent, terms: termsConsent, revealOptIn };
    try {
      const reply = tab === "create"
        ? await onCreate(alias.trim(), consent, profile, demoRoom ? { demo: true } : undefined)
        : await onJoin(code, alias.trim(), consent, profile);
      if (!reply.ok) setLocalError(reply.error ?? "Could not get in.");
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Could not reach the game server.");
    }
  };

  return (
    <main className="screen relative flex flex-col items-center justify-center px-5 py-10">
      <motion.div variants={staggerContainer} initial="initial" animate="animate" className="w-full max-w-md flex flex-col items-center gap-5">
        <motion.div variants={staggerItem} className="flex flex-col items-center gap-2">
          <Flame size={86} />
          <p className="text-[11px] tracking-[0.28em] uppercase text-white/60 font-medium">A game for friends</p>
        </motion.div>

        <motion.div variants={staggerItem} className="w-full">
          <AnimatedWords text="The Reveal Game" highlightWord="Reveal" className="text-display-lg md:text-display-xl text-center" />
        </motion.div>

        <motion.p variants={staggerItem} className="text-center text-white/65 text-sm leading-relaxed max-w-sm">
          One phone each. Four to eleven friends. Answer honestly and see what the night reveals.
        </motion.p>

        <motion.div variants={staggerItem} className="w-full">
          <GlassCard className="w-full p-5 md:p-6">
            <div className="mb-5 grid grid-cols-2 gap-1 rounded-2xl bg-white/5 p-1">
              {(["create", "join"] as Tab[]).map((t) => (
                <button key={t} type="button" onClick={() => { setTab(t); setLocalError(null); }}
                  className={clsx("min-h-[48px] rounded-xl text-sm font-medium transition-colors", tab === t ? "bg-white/12 text-white" : "text-white/55")}
                  aria-pressed={tab === t}>
                  {t === "create" ? "Create a room" : "Join a room"}
                </button>
              ))}
            </div>

            <form onSubmit={(event) => { event.preventDefault(); void go(); }}>
              <label className="block text-xs uppercase tracking-[0.18em] text-white/60 mb-2" htmlFor="alias">Your alias</label>
              <input id="alias" className="field mb-1" value={alias} onChange={(e) => setAlias(e.target.value.slice(0, 14))}
                placeholder="What should we call you?" autoComplete="off" autoCapitalize="words" maxLength={14} inputMode="text" />
              <p className={clsx("text-[11px] mb-4", aliasOk || !alias ? "text-white/45" : "text-alert")}>
                Pick a name between 2 and 14 characters.
              </p>

              {tab === "join" && <>
                <label className="block text-xs uppercase tracking-[0.18em] text-white/60 mb-2" htmlFor="code">Room code</label>
                <input id="code" className="field mb-1 text-center font-display text-2xl tracking-[0.35em] uppercase" value={code}
                  onChange={(e) => setCode(sanitizeCode(e.target.value))} placeholder="ABCD" autoComplete="off"
                  autoCapitalize="characters" spellCheck={false} inputMode="text" />
                <p className="text-[11px] text-white/45 mb-4">Paste or type the four characters from your host.</p>
              </>}

              <fieldset className="mb-4 space-y-3 rounded-2xl border border-white/10 p-4">
                <legend className="px-2 text-sm font-semibold">A little about you · 18+</legend>
                {PROFILE_QUESTIONS.map(q => <div key={q.field}>
                  <label className="mb-1 block text-xs text-white/65" htmlFor={`profile-${q.field}`}>{q.label}</label>
                  {q.kind === "number" && <input id={`profile-${q.field}`} className="field" type="number" min={q.field === "age" ? AGE_MIN : 0} max={q.field === "age" ? 120 : q.field === "partnersToDate" ? 200 : 1200} value={profile[q.field as "age" | "partnersToDate" | "longestMonths"] || ""} onChange={e => setProfile(p => ({ ...p, [q.field]: Number(e.target.value) }))} />}
                  {q.field === "relationship" && <select id="profile-relationship" className="field" value={profile.relationship} onChange={e => setProfile(p => ({ ...p, relationship: e.target.value as ProfileAnswers["relationship"] }))}>{["single", "dating", "committed", "married", "complicated"].map(v => <option className="text-black" key={v}>{v}</option>)}</select>}
                  {q.field === "tonight" && <select id="profile-tonight" className="field" value={profile.tonight} onChange={e => setProfile(p => ({ ...p, tonight: e.target.value as ProfileAnswers["tonight"] }))}>{["chaos", "vibes", "feelings", "mission"].map(v => <option className="text-black" key={v}>{v}</option>)}</select>}
                  {q.field === "crushingHere" && <button id="profile-crushingHere" type="button" aria-pressed={profile.crushingHere} onClick={() => setProfile(p => ({ ...p, crushingHere: !p.crushingHere }))} className="min-h-[40px] rounded-xl border border-white/20 px-3">{profile.crushingHere ? "Yes" : "No"} · stays secret</button>}
                </div>)}
                {profile.age > 0 && profile.age < AGE_MIN && <p role="alert" className="text-sm text-alert">This game is 18+ only.</p>}
              </fieldset>
              <div className="mb-4 space-y-2">
                <label className="flex items-start gap-3 text-xs text-white/65"><input type="checkbox" checked={ageConsent} onChange={e => setAgeConsent(e.target.checked)} /> I am {AGE_MIN} or older.</label>
                <label className="flex items-start gap-3 text-xs text-white/65"><input type="checkbox" checked={termsConsent} onChange={e => setTermsConsent(e.target.checked)} /> I agree to the house rules.</label>
              </div>
              {tab === "create" && (
                <button
                  type="button"
                  onClick={() => setDemoRoom((value) => !value)}
                  aria-pressed={demoRoom}
                  className={clsx(
                    "mb-4 flex min-h-[48px] w-full items-center justify-between rounded-xl px-3 text-left text-xs",
                    demoRoom ? "bg-lime-accent/15 text-lime-accent" : "bg-white/5 text-white/55"
                  )}
                >
                  <span>
                    Demo room
                    <span className="block text-[11px] text-white/40">Test the whole game alone on this laptop.</span>
                  </span>
                  <span className="text-[10px] uppercase tracking-[0.18em]">{demoRoom ? "on" : "off"}</span>
                </button>
              )}

              <div className="mb-4 flex flex-wrap items-center gap-x-4">
                <button type="button" onClick={() => setShowPrivacyOptions((value) => !value)} aria-expanded={showPrivacyOptions}
                  className="min-h-[40px] text-left text-xs text-white/55 underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-accent">
                  Privacy options
                </button>
                {showPrivacyOptions && <button type="button" onClick={() => setRevealOptIn((value) => !value)} aria-pressed={revealOptIn}
                  className="min-h-[40px] text-left text-xs text-lime-accent underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-accent">
                  Private cards: {revealOptIn ? "on · turn off" : "off · turn on"}
                </button>}
              </div>
              <GlowButton type="submit" className="w-full" disabled={!canGo}>
                {busy ? "Getting you in…" : tab === "create" ? "Create room" : "Join room"}
              </GlowButton>
            </form>

            {(localError || error) && <p className="mt-3 text-sm text-alert" role="alert">{localError ?? error}</p>}
            {hasSession && <p className="mt-4 text-center text-[11px] text-white/40">There&apos;s already a session in this tab.</p>}
          </GlassCard>
        </motion.div>

        <motion.p variants={staggerItem} className="text-center text-[11px] text-white/40 max-w-xs leading-relaxed">
          Your room is private. Any player can delete it when the night is over.
        </motion.p>
      </motion.div>
    </main>
  );
}

"use client";
// components/JoinScreen.tsx — the phone's sign-up.
//
// THE FIELDS ARE EXACTLY THESE: a name/alias, age, gender, sexuality,
// attraction and what you are here for. No relationship history. The answers
// stay on the server — they are never shown, never compared, never printed.
import { useEffect, useMemo, useState } from "react";
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

const EMPTY_PROFILE: ProfileAnswers = {
  age: 0,
  gender: "undisclosed",
  sexuality: "undisclosed",
  attractedTo: "undisclosed",
  lookingFor: "undisclosed",
};

export function JoinScreen({
  hasSession,
  busy,
  error,
  onJoin,
}: {
  hasSession: boolean;
  busy: boolean;
  error: string | null;
  onJoin: (code: RoomCode, alias: string, consent: Consent, profile: ProfileAnswers) => Promise<JoinReply>;
}) {
  const [alias, setAlias] = useState("");
  const [code, setCode] = useState("");
  const [ageConsent, setAgeConsent] = useState(false);
  const [profile, setProfile] = useState<ProfileAnswers>(EMPTY_PROFILE);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem("reveal.alias");
      if (saved) setAlias(saved);
    } catch { /* Storage may be disabled; manual entry still works. */ }
    // The QR carries the room code — no typing needed.
    const invite = new URLSearchParams(window.location.search).get("room");
    if (invite) setCode(sanitizeCode(invite));
  }, []);

  const aliasOk = isAlias(alias);
  const profileComplete = useMemo(
    () => Number.isInteger(profile.age) && profile.age >= AGE_MIN && profile.age <= 120,
    [profile.age],
  );
  const canGo = aliasOk && profileComplete && ageConsent && code.length === 4 && !busy;

  const go = async () => {
    if (!canGo) return;
    setLocalError(null);
    try { window.sessionStorage.setItem("reveal.alias", alias.trim()); } catch { /* optional */ }
    const consent: Consent = { age: ageConsent, terms: true };
    try {
      const reply = await onJoin(code as RoomCode, alias.trim(), consent, profile);
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
            <form onSubmit={(event) => { event.preventDefault(); void go(); }}>
              <label className="block text-xs uppercase tracking-[0.18em] text-white/60 mb-2" htmlFor="alias">Your alias</label>
              <input id="alias" className="field mb-1" value={alias} onChange={(e) => setAlias(e.target.value.slice(0, 14))}
                placeholder="What should we call you?" autoComplete="off" autoCapitalize="words" maxLength={14} inputMode="text" />
              <p className={clsx("text-[11px] mb-4", aliasOk || !alias ? "text-white/45" : "text-alert")}>
                Pick a name between 2 and 14 characters.
              </p>

              <label className="block text-xs uppercase tracking-[0.18em] text-white/60 mb-2" htmlFor="code">Room code</label>
              <input id="code" className="field mb-1 text-center font-display text-2xl tracking-[0.35em] uppercase" value={code}
                onChange={(e) => setCode(sanitizeCode(e.target.value))} placeholder="ABCD" autoComplete="off"
                autoCapitalize="characters" spellCheck={false} inputMode="text" />
              <p className="text-[11px] text-white/45 mb-4">It came with the QR. You can also type the four characters.</p>

              <fieldset className="mb-4 space-y-3 rounded-2xl border border-white/10 p-4">
                <legend className="px-2 text-sm font-semibold">A little about you</legend>
                {PROFILE_QUESTIONS.map((q) => {
                  const id = `profile-${q.field}`;
                  if (q.kind === "number") {
                    return (
                      <div key={q.field}>
                        <label className="mb-1 block text-xs text-white/65" htmlFor={id}>{q.label}</label>
                        <input id={id} className="field" type="number" inputMode="numeric" min={AGE_MIN} max={120}
                          value={profile.age || ""} onChange={(e) => setProfile((p) => ({ ...p, age: Number(e.target.value) }))} />
                      </div>
                    );
                  }
                  return (
                    <div key={q.field}>
                      <label className="mb-1 block text-xs text-white/65" htmlFor={id}>{q.label}</label>
                      <select id={id} className="field" value={profile[q.field as "gender" | "sexuality" | "attractedTo" | "lookingFor"]}
                        onChange={(e) => setProfile((p) => ({ ...p, [q.field]: e.target.value } as ProfileAnswers))}>
                        {q.options.map((option) => <option className="text-black" key={option} value={option}>{option}</option>)}
                      </select>
                    </div>
                  );
                })}
                {profile.age > 0 && profile.age < AGE_MIN && <p role="alert" className="text-sm text-alert">This game is 18+ only.</p>}
                <p className="text-[11px] text-white/40 leading-relaxed">
                  Your answers stay on the server. Nobody sees them, and they are never printed.
                </p>
              </fieldset>

              <label className="mb-4 flex items-start gap-3 text-xs text-white/65">
                <input type="checkbox" checked={ageConsent} onChange={(e) => setAgeConsent(e.target.checked)} />
                I am {AGE_MIN} or older.
              </label>

              <GlowButton type="submit" className="w-full" disabled={!canGo}>
                {busy ? "Getting you in…" : "Join the room"}
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

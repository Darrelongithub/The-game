"use client";
// components/JoinScreen.tsx — Agent A. Create OR join, alias, the three
// consent gates (18+ is the hard one), and auto-resume when this tab already
// holds a session.
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { Consent, JoinReply, RoomCode } from "@shared/contracts.ts";
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, AGE_MIN } from "@shared/contracts.ts";
import { isAlias } from "@shared/validate.ts";
import { GlassCard } from "@/components/GlassCard";
import { GlowButton } from "@/components/GlowButton";
import { AnimatedWords } from "@/components/AnimatedWords";
import { Flame } from "@/components/Flame";
import { staggerContainer, staggerItem } from "@/lib/motion";
import { clsx } from "clsx";

type Tab = "create" | "join";

const sanitizeCode = (raw: string): string =>
  [...raw.toUpperCase()]
    .filter((c) => ROOM_CODE_ALPHABET.includes(c))
    .slice(0, ROOM_CODE_LENGTH)
    .join("");

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
  onCreate: (alias: string, consent: Consent) => Promise<JoinReply & { code?: RoomCode }>;
  onJoin: (code: RoomCode, alias: string, consent: Consent) => Promise<JoinReply>;
}) {
  const [tab, setTab] = useState<Tab>("create");
  const [alias, setAlias] = useState("");
  const [code, setCode] = useState("");
  const [age, setAge] = useState(false);
  const [terms, setTerms] = useState(false);
  const [revealOptIn, setRevealOptIn] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // Remember the alias across reloads on this tab (never the room itself).
  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem("reveal.alias");
      if (saved) setAlias(saved);
    } catch {
      /* ignore */
    }
  }, []);

  const aliasOk = isAlias(alias);
  const codeOk = code.length === ROOM_CODE_LENGTH;
  const allConsent = age && terms && revealOptIn;
  const canGo = aliasOk && allConsent && (tab === "create" || codeOk) && !busy;

  const consent: Consent = useMemo(() => ({ age, terms, revealOptIn }), [age, terms, revealOptIn]);

  const persistAlias = () => {
    try {
      window.sessionStorage.setItem("reveal.alias", alias.trim());
    } catch {
      /* ignore */
    }
  };

  const go = async () => {
    if (!canGo) return;
    setLocalError(null);
    persistAlias();
    const reply =
      tab === "create" ? await onCreate(alias.trim(), consent) : await onJoin(code, alias.trim(), consent);
    if (!reply.ok) setLocalError(reply.error ?? "Could not get in.");
  };

  return (
    <main className="screen relative flex flex-col items-center justify-center px-5 py-10">
      <motion.div
        variants={staggerContainer}
        initial="initial"
        animate="animate"
        className="w-full max-w-md flex flex-col items-center gap-6"
      >
        <motion.div variants={staggerItem} className="flex flex-col items-center gap-3">
          <Flame size={72} />
          <p className="text-[11px] tracking-[0.28em] uppercase text-white/50 font-medium">
            Private · 18+ · {AGE_MIN}+ only
          </p>
        </motion.div>

        <motion.div variants={staggerItem} className="w-full">
          <AnimatedWords
            text="The Reveal Game"
            highlightWord="Reveal"
            className="text-display-lg md:text-display-xl text-center"
          />
        </motion.div>

        <motion.p variants={staggerItem} className="text-center text-white/60 text-sm leading-relaxed max-w-sm">
          One phone each. Four to eleven friends. Answer honestly — the night keeps
          receipts and hands them back at the end.
        </motion.p>

        <motion.div variants={staggerItem} className="w-full">
          <GlassCard className="w-full p-5 md:p-6">
            {/* tab switch */}
            <div className="mb-5 grid grid-cols-2 gap-1 rounded-2xl bg-white/5 p-1">
              {(["create", "join"] as Tab[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={clsx(
                    "min-h-[48px] rounded-xl text-sm font-medium transition-colors",
                    tab === t ? "bg-white/12 text-white" : "text-white/55"
                  )}
                  aria-pressed={tab === t}
                >
                  {t === "create" ? "Create a room" : "Join a room"}
                </button>
              ))}
            </div>

            <label className="block text-xs uppercase tracking-[0.18em] text-white/45 mb-2" htmlFor="alias">
              Your alias
            </label>
            <input
              id="alias"
              className="field mb-1"
              value={alias}
              onChange={(e) => setAlias(e.target.value.slice(0, 14))}
              placeholder="e.g. Wachuki"
              autoComplete="off"
              autoCapitalize="words"
              maxLength={14}
              inputMode="text"
            />
            <p className={clsx("text-[11px] mb-4", aliasOk || !alias ? "text-white/35" : "text-alert")}>
              2–14 characters. Real names optional — your alias stays on your phone&apos;s room only.
            </p>

            {tab === "join" && (
              <>
                <label className="block text-xs uppercase tracking-[0.18em] text-white/45 mb-2" htmlFor="code">
                  Room code
                </label>
                <input
                  id="code"
                  className="field mb-1 text-center font-display text-2xl tracking-[0.5em] uppercase"
                  value={code}
                  onChange={(e) => setCode(sanitizeCode(e.target.value))}
                  placeholder="ABCD"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={ROOM_CODE_LENGTH}
                  inputMode="text"
                  style={{ paddingLeft: "1.75rem" }}
                />
                <p className="text-[11px] text-white/35 mb-4">Four characters from the host&apos;s screen.</p>
              </>
            )}

            {/* consent gates — the button stays dead until all three are true */}
            <div className="space-y-2.5 mb-5">
              <ConsentRow
                checked={age}
                onChange={setAge}
                label={`I'm ${AGE_MIN} or older`}
                hint="This room is adults only. No exceptions."
              />
              <ConsentRow
                checked={terms}
                onChange={setTerms}
                label="I agree to the house rules"
                hint="Private group, nothing leaves these phones, no screenshots out."
              />
              <ConsentRow
                checked={revealOptIn}
                onChange={setRevealOptIn}
                label="I opt in to private reveal cards"
                hint="Secrets land on YOUR phone only, face-down, hold to open. Decline and you get none."
              />
            </div>

            <GlowButton className="w-full" onClick={go} disabled={!canGo}>
              {busy ? "Getting you in…" : tab === "create" ? "Create room" : "Join room"}
            </GlowButton>

            {(localError || error) && (
              <p className="mt-3 text-sm text-alert" role="alert">
                {localError ?? error}
              </p>
            )}

            {hasSession && (
              <p className="mt-4 text-center text-[11px] text-white/40">
                There&apos;s a session in this tab — it resumes automatically. Starting a new
                room here replaces it.
              </p>
            )}
          </GlassCard>
        </motion.div>

        <motion.p variants={staggerItem} className="text-center text-[11px] text-white/30 max-w-xs leading-relaxed">
          Everything runs on the host&apos;s machine. Rooms die after 48 hours, and any
          player can delete the whole thing instantly.
        </motion.p>
      </motion.div>
    </main>
  );
}

function ConsentRow({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      className={clsx(
        "w-full min-h-[56px] text-left rounded-2xl border px-3.5 py-3 flex items-start gap-3 transition-colors",
        checked ? "border-lime-accent/50 bg-lime-accent/10" : "border-white/12 bg-white/[0.03]"
      )}
    >
      <span
        className={clsx(
          "mt-0.5 h-5 w-5 shrink-0 rounded-md border flex items-center justify-center text-[13px] leading-none",
          checked ? "border-lime-accent bg-lime-accent text-black" : "border-white/30 text-transparent"
        )}
        aria-hidden
      >
        ✓
      </span>
      <span>
        <span className="block text-sm text-white">{label}</span>
        <span className="block text-[11px] text-white/40 leading-snug mt-0.5">{hint}</span>
      </span>
    </button>
  );
}

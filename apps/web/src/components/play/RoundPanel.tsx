"use client";
// components/play/RoundPanel.tsx — Agent A placeholder input surface.
//
// Agent B2 owns the real per-round screens (animations, shove, haptics). This
// one exists so the shell can be driven end-to-end today: it is a correct,
// cross-platform renderer for all nine round kinds against the frozen
// contracts, including `onlyPlayers` spectator mode.
import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import type {
  PlayerId,
  PlayerView,
  ResponseValue,
  RoundView,
  TraitId,
} from "@shared/contracts.ts";
import { TRAITS } from "@shared/contracts.ts";
import { GlassCard } from "@/components/GlassCard";
import { GlowButton } from "@/components/GlowButton";
import { useCountdown, formatLeft } from "@/lib/useCountdown";
import { clsx } from "clsx";

/** Interim shim: the round needs to say WHICH trait / WHICH player it asks
 *  about. Filed as a contract request (see NOTES). Until the server sends it,
 *  the UI simply lets the player choose. */
type RoundShim = RoundView & { trait?: TraitId; about?: PlayerId; coding?: string };

const HEAT_LABEL: Record<string, string> = {
  warmup: "Warmup",
  spicy: "Spicy",
  deep: "Deep",
  dare: "Dare",
  debrief: "Debrief",
};

const HEAT_VAR: Record<string, string> = {
  warmup: "var(--heat-warmup)",
  spicy: "var(--heat-spicy)",
  deep: "var(--heat-deep)",
  dare: "var(--heat-dare)",
  debrief: "var(--heat-dare)",
};

export function RoundPanel({
  round,
  players,
  you,
  mustAnswer,
  submitted,
  onSubmit,
  onDarePass,
  onSkip,
  isHost,
}: {
  round: RoundView;
  players: PlayerView[];
  you: PlayerId | null;
  mustAnswer: boolean;
  submitted: boolean;
  onSubmit: (value: ResponseValue) => void;
  onDarePass: (reason: string) => void;
  onSkip: () => void;
  isHost: boolean;
}) {
  const shim = round as RoundShim;
  const left = useCountdown(round.closesAt);
  const others = players.filter((p) => p.id !== you);
  const heatColor = HEAT_VAR[round.phase] ?? "var(--heat-warmup)";

  const [target, setTarget] = useState<PlayerId | "self">(shim.about ?? "self");
  const [trait, setTrait] = useState<TraitId>(shim.trait ?? "loyalty");
  const [value, setValue] = useState<number>(round.kind === "ios" ? 4 : 6);
  const [text, setText] = useState("");
  const [taps, setTaps] = useState(0);
  const [passing, setPassing] = useState(false);
  const [reason, setReason] = useState("");
  const tapStart = useRef<number | null>(null);
  // The round window is fixed at mount (PlayScreen keys this panel by roundId).
  const totalRef = useRef(Math.max(1, round.closesAt - Date.now()));

  useEffect(() => {
    if (shim.about) setTarget(shim.about);
    if (shim.trait) setTrait(shim.trait);
  }, [round.roundId, shim.about, shim.trait]);

  const waiting = !mustAnswer || submitted;
  const pct = Math.max(0, Math.min(1, left / totalRef.current));

  const send = (v: ResponseValue) => onSubmit(v);

  return (
    <main className="screen relative flex flex-col px-5 py-6 gap-4">
      {/* round header: heat + index + timer */}
      <div className="flex items-center justify-between gap-3">
        <span
          className="text-[10px] uppercase tracking-[0.22em] px-2.5 py-1 rounded-full"
          style={{ color: heatColor, border: `1px solid ${heatColor}55`, background: `${heatColor}12` }}
        >
          {HEAT_LABEL[round.phase] ?? round.phase} · {round.kind.replace("_", " ")}
        </span>
        <span className="text-xs text-white/45 tabular-nums">round {round.index}</span>
        <span className="text-sm text-white/70 tabular-nums" aria-live="polite">
          {formatLeft(left)}
        </span>
      </div>
      <div className="h-[3px] w-full rounded-full bg-white/10 overflow-hidden">
        <motion.div
          className="h-full rounded-full"
          style={{ background: heatColor, width: `${Math.max(2, pct * 100)}%` }}
          animate={{ opacity: left < 6000 ? [1, 0.35, 1] : 1 }}
          transition={left < 6000 ? { duration: 0.9, repeat: Infinity } : undefined}
        />
      </div>

      <GlassCard className="p-5 md:p-7">
        <p className="font-display text-[clamp(1.25rem,4.6vw,1.75rem)] leading-tight text-white">
          {round.promptText}
        </p>

        {waiting ? (
          <WaitingState round={round} mustAnswer={mustAnswer} submitted={submitted} players={players} you={you} />
        ) : (
          <div className="mt-6">
            {round.kind === "pick" && (
              <div className="grid grid-cols-2 gap-2">
                {others.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => send({ kind: "pick", target: p.id })}
                    className="min-h-[52px] rounded-2xl border border-white/12 bg-white/[0.04] px-3 text-sm text-white active:scale-[0.98] transition-transform"
                  >
                    {p.alias}
                  </button>
                ))}
              </div>
            )}

            {(round.kind === "text" || round.kind === "debrief") && (
              <>
                <textarea
                  className="field min-h-[110px]"
                  maxLength={280}
                  value={text}
                  onChange={(e) => setText(e.target.value.slice(0, 280))}
                  placeholder={round.kind === "debrief" ? "What they actually said. Be specific." : "Type it. Nobody sees it raw."}
                  aria-label="Your answer"
                />
                <div className="flex items-center justify-between mt-2">
                  <span className="text-[11px] text-white/35 tabular-nums">{text.length}/280</span>
                  <GlowButton
                    className="px-5 py-2.5 text-sm"
                    disabled={text.trim().length === 0}
                    onClick={() => send({ kind: "text", text: text.trim() })}
                  >
                    Send
                  </GlowButton>
                </div>
              </>
            )}

            {round.kind === "shout" && (
              <>
                <input
                  className="field text-center font-display text-2xl uppercase tracking-wide"
                  maxLength={24}
                  value={text}
                  onChange={(e) => setText(e.target.value.replace(/\s+/g, "").slice(0, 24))}
                  placeholder="ONE WORD"
                  aria-label="One word"
                  autoFocus
                />
                <div className="flex items-center justify-between mt-2">
                  <span className="text-[11px] text-white/35">{text.length}/24 · one word only</span>
                  <GlowButton
                    className="px-5 py-2.5 text-sm"
                    disabled={text.trim().length === 0}
                    onClick={() => send({ kind: "shout", word: text.trim() })}
                  >
                    Shout
                  </GlowButton>
                </div>
              </>
            )}

            {round.kind === "rating" && (
              <>
                {!shim.trait && (
                  <Chooser
                    label="Which trait?"
                    options={TRAITS.map((t) => ({ id: t, label: t }))}
                    value={trait}
                    onChange={(v) => setTrait(v as TraitId)}
                  />
                )}
                {!shim.about && (
                  <Chooser
                    label="About whom?"
                    options={[{ id: "self", label: "myself" }, ...others.map((p) => ({ id: p.id, label: p.alias }))]}
                    value={target}
                    onChange={(v) => setTarget(v)}
                  />
                )}
                <Scale
                  min={1}
                  max={10}
                  value={value}
                  onChange={setValue}
                  onSend={() =>
                    send(
                      target === "self"
                        ? { kind: "rating", trait, about: "self", value }
                        : { kind: "rating", trait, about: target, value }
                    )
                  }
                />
              </>
            )}

            {round.kind === "ios" && (
              <>
                {!shim.about && (
                  <Chooser
                    label="How close to whom?"
                    options={others.map((p) => ({ id: p.id, label: p.alias }))}
                    value={target === "self" ? others[0]?.id ?? "" : target}
                    onChange={(v) => setTarget(v)}
                  />
                )}
                <Scale
                  min={1}
                  max={7}
                  value={value}
                  onChange={setValue}
                  label={(v) => `${v}/7 circles`}
                  onSend={() => {
                    const about = target === "self" ? others[0]?.id : target;
                    if (about) send({ kind: "ios", about, value });
                  }}
                />
              </>
            )}

            {round.kind === "minigame" && (
              <div className="flex flex-col items-center gap-4">
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.94 }}
                  onPointerDown={() => {
                    if (tapStart.current === null) tapStart.current = Date.now();
                    setTaps((t) => t + 1);
                    if ("vibrate" in navigator) {
                      try {
                        navigator.vibrate(6);
                      } catch {
                        /* ignore */
                      }
                    }
                  }}
                  className="h-40 w-40 rounded-full glass-card flex items-center justify-center font-display text-4xl tabular-nums text-lime-accent select-none no-callout"
                  aria-label="Tap as fast as you can"
                >
                  {taps}
                </motion.button>
                <GlowButton
                  variant="accent"
                  className="w-full"
                  disabled={taps === 0}
                  onClick={() => send({ kind: "minigame", score: taps })}
                >
                  Lock in {taps} taps
                </GlowButton>
              </div>
            )}

            {(round.kind === "dare" || round.kind === "pair_dare") && (
              <div className="flex flex-col gap-3">
                {!passing ? (
                  <>
                    <GlowButton className="w-full" onClick={() => send({ kind: "dare", status: "done" })}>
                      I did it
                    </GlowButton>
                    <button
                      type="button"
                      onClick={() => setPassing(true)}
                      className="min-h-[48px] rounded-2xl border border-alert/40 text-alert text-sm"
                    >
                      I can&apos;t — ask me why
                    </button>
                  </>
                ) : (
                  <>
                    <textarea
                      className="field min-h-[90px]"
                      maxLength={140}
                      value={reason}
                      onChange={(e) => setReason(e.target.value.slice(0, 140))}
                      placeholder="The reason is the point. It gets quoted later."
                      aria-label="Why can't you do it?"
                    />
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-white/35 tabular-nums">{reason.length}/140</span>
                      <GlowButton
                        className="px-5 py-2.5 text-sm"
                        disabled={reason.trim().length === 0}
                        onClick={() => onDarePass(reason.trim())}
                      >
                        Record the excuse
                      </GlowButton>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </GlassCard>

      {isHost && (
        <button
          type="button"
          onClick={onSkip}
          className="mt-auto mx-auto min-h-[48px] px-4 text-[11px] uppercase tracking-[0.2em] text-white/30"
        >
          host: skip this round
        </button>
      )}
    </main>
  );
}

function WaitingState({
  round,
  mustAnswer,
  submitted,
  players,
  you,
}: {
  round: RoundView;
  mustAnswer: boolean;
  submitted: boolean;
  players: PlayerView[];
  you: PlayerId | null;
}) {
  if (!mustAnswer && round.onlyPlayers?.length) {
    const names = round.onlyPlayers
      .map((id) => players.find((p) => p.id === id)?.alias ?? "Player")
      .filter(Boolean);
    return (
      <div className="mt-6 text-center py-6">
        <motion.div
          className="mx-auto mb-4 h-10 w-10 rounded-full border border-white/15"
          animate={{ scale: [1, 1.12, 1], opacity: [0.5, 1, 0.5] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
        />
        <p className="font-display text-heading text-white/85">They&apos;re talking…</p>
        <p className="mt-2 text-sm text-white/45">
          {names.join(" and ")} stepped out together. You get the debrief, not the details.
        </p>
      </div>
    );
  }
  return (
    <div className="mt-6 text-center py-6">
      <motion.p
        className="font-display text-heading text-lime-accent"
        animate={{ opacity: [0.55, 1, 0.55] }}
        transition={{ duration: 1.6, repeat: Infinity }}
      >
        {submitted ? "Sent." : "Waiting on the room…"}
      </motion.p>
      <p className="mt-2 text-sm text-white/45">
        {submitted ? "Sit tight — it lands with everyone else at the same time." : "No peeking."}
      </p>
      {you && <p className="mt-4 text-[11px] text-white/25">your answers are locked to this phone</p>}
    </div>
  );
}

function Chooser({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="mb-4">
      <p className="text-[11px] uppercase tracking-[0.18em] text-white/40 mb-2">{label}</p>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className={clsx(
              "min-h-[48px] px-3 rounded-xl border text-sm capitalize",
              value === o.id ? "border-lime-accent/60 bg-lime-accent/10 text-white" : "border-white/12 text-white/60"
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Scale({
  min,
  max,
  value,
  onChange,
  onSend,
  label,
}: {
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
  onSend: () => void;
  label?: (v: number) => string;
}) {
  return (
    <div>
      <p className="text-center font-display text-3xl text-lime-accent tabular-nums mb-3">
        {label ? label(value) : value}
      </p>
      <div className="grid grid-cols-5 gap-1.5 mb-4">
        {Array.from({ length: max - min + 1 }).map((_, i) => {
          const v = min + i;
          return (
            <button
              key={v}
              type="button"
              onClick={() => onChange(v)}
              className={clsx(
                "min-h-[48px] rounded-xl text-sm tabular-nums border",
                v === value
                  ? "border-lime-accent/70 bg-lime-accent/15 text-white"
                  : "border-white/10 bg-white/[0.03] text-white/55"
              )}
              aria-pressed={v === value}
            >
              {v}
            </button>
          );
        })}
      </div>
      <GlowButton className="w-full" onClick={onSend}>
        Lock it in
      </GlowButton>
    </div>
  );
}

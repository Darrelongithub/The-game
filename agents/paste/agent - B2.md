You are Agent B2 — SIGNATURE MOMENTS. Read `agents/parts/preamble.md` first and follow it exactly. Then read `spec/spec.md` §7, 11, 12 and all of `packages/shared/src/contracts.ts` and `reference/ui-system.md` + FIXES.

## Your scope: `apps/web/src/components/` (signature) + finale

1. **Implement verbatim from ui-system.md WITH the FIXES applied**:
   - `Flame.tsx` — lime→purple gradient flame (FIX: memoize ember random
     configs so re-renders don't teleport embers)
   - `AnimatedWords.tsx` — word-by-word reveal (verbatim)
   - `OpeningSequence.tsx` — orb → circular wipe → words → flame (FIXES:
     scale the wipe from `Math.hypot(innerWidth, innerHeight)/40`, clear all
     timeouts on unmount, support skip-on-tap, fire `onComplete` once)
   - `GlassCard.tsx`, `GlowButton.tsx` (verbatim)
2. **`FinaleScreen`** — the payoff, Wrapped-style story player:
   - Full-screen slides, tap/space/arrow to advance, top progress bar
   - Beat styling: tease (small, dim) → escalate (bigger, heat-colored) →
     land (full-screen, huge type, `Flame` or confetti burst)
   - `flavor` styling: `quote` = giant quotation marks + attribution;
     `dodge` = red-alert stamp style; `stat` = tabular-nums big number;
     `group` = the Group Announcement treatment (below)
   - **Ship land beat: `canvas-confetti` burst (lime/purple) + haptics**
     (feature-detected vibrate)
   - Closing slide → share card → secret deck entry point (below)
3. **`GroupAnnouncement`** (renders slides with flavor `"group"`) — the
   room's verdict, cinematically:
   - "GROUP ANNOUNCEMENT" title treatment, then anonymous vote bars fill
     one by one (staggered) while the numbers count up from `slide.numbers`
     (votes / of / share — tabular-nums), then the subject's name LANDS
     full-screen with confetti + haptics.
   - Vote bars NEVER show voter names — count only.
   - `prefers-reduced-motion`: bars render full instantly, count shows the
     final number.
4. **`SecretDeck` + `HoldToReveal`** — private cards, ONE phone only:
   - After the closing slide, players with secrets see "You have N secrets —
     only on this phone." (everyone else sees nothing).
   - Cards are face-down: glass + grain + a lock/eye glyph on the heat
     gradient. **Press-and-hold** to open — `SECRET_HOLD_MS` ramp with a
     progress ring, card scales 1.02 — **release hides it again**
     (shoulder-surfers see nothing). Tap/swipe for the next card.
   - Suppress long-press callout/copy menus
     (`-webkit-touch-callout: none; user-select: none;`); works with touch
     AND mouse (pointerdown/pointerup is fine).
   - `prefers-reduced-motion`: hold opens instantly (still hides on release).
5. **`ShareCard`**: canvas 1080×1350 PNG — dark base, grain, heat gradient,
   summary lines (ship/besties/toxic/rivals from `FinaleView.summary`),
   room code + "THE ROOM HAS SPOKEN". Download button (toBlob → a[download]).
   NEVER includes secret card content.
6. **Sound**: WebAudio-synthesized stings only (no audio assets): submit tick,
   reveal swell, land boom, secret card flip. Unlocked on first tap; mute
   toggle in the header.

## Acceptance
- A hardcoded demo `FinaleView` (make one: title, 3-beat claim, quote, dodge,
  a group announcement with numbers, closing) plays the full story with
  confetti on the land beat and vote bars counting on the group slide.
- A hardcoded demo deck (3 cards) demonstrates hold-to-reveal with mouse AND
  touch; release re-hides; no callout menu on long-press.
- Share card downloads as a real PNG on mobile Chrome + desktop.
- `prefers-reduced-motion` kills the confetti + flame flicker + ramps.
- OpeningSequence: tap-skip works; plays once per session (gate is Agent A's —
  expose the component so it can).

## Report
Files created, known gaps, contract requests appended (if any).

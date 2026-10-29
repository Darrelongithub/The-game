# UI System — REQUIRED FIXES (apply on top of ui-system.md verbatim code)

The UI system is excellent and ships as-is, with these 7 fixes. Agents A and
B2 own them; Agent Z verifies each one.

1. **Tailwind v3 — PINNED (critical).** The pasted `globals.css` uses
   `@tailwind base/components/utilities` and `tailwind.config.ts` with v3
   syntax. Current `create-next-app` scaffolds **Tailwind v4** (CSS-first,
   no config file) which silently breaks ALL of it. Install explicitly:
   `npm i -D tailwindcss@3 postcss autoprefixer`.
2. **Opening sequence plays ONCE per session + tap-to-skip.** A 4.2s intro on
   every re-join (and there are many re-joins on flaky mobile) will get the
   game thrown at a wall. Gate it with a sessionStorage flag (`intro-done`);
   any tap during the sequence skips straight to `onComplete`.
3. **Flame embers must be memoized.** The pasted code calls `Math.random()`
   inside the render (ember positions + animation values). Any state change
   re-rolls every ember → they teleport. Compute ember configs once in
   `useMemo` and map over them.
4. **Circular wipe must scale from the viewport.** `scale: 60` on a 40px circle
   = 2400px — fine on phones, NOT guaranteed on tablets/large windows. Use
   `Math.hypot(window.innerWidth, window.innerHeight) / 40` (×1.1 safety).
5. **Timer cleanup.** `OpeningSequence` chains raw `setTimeout`s with no
   cleanup — if the component unmounts mid-sequence the callbacks fire on a
   dead component. Store timer ids in a ref array and clear on unmount; make
   `onComplete` fire exactly once (guard flag).
6. **Font fallback.** `next/font/local` hard-requires
   `public/fonts/ClashDisplay-Variable.woff2` (fontshare.com). If the file is
   missing the build fails — commit the font file to the repo, and keep the
   `'Inter', system-ui` fallback chain so a missing display font degrades,
   never crashes.
7. **Throttle the cursor glow.** The mousemove handler writes `style.transform`
   per event — wrap it in `requestAnimationFrame` (one pending frame max).

## Notes (not bugs)
- `framer-motion` as imported is still published and maintained (the library
  renamed its package to `motion`, but `framer-motion` v12 works identically).
  Keep the paste's imports.
- `canvas-confetti` is installed but unused in the paste — Agent B2 uses it
  for the SHIP land beat (lime/purple burst).
- Game layer additions to `:root` (see spec §12): `--red-alert: #ff4d6d`
  (dare phase + "most toxic" moments) and heat mapping
  `--heat-warmup/--spicy/--deep/--dare` = `#3b82f6/#b6ff3c/#8b2fe0/#ff4d6d`.
- The paste's cross-platform checklist (9 points) is adopted verbatim as
  spec §11 items 1–9; items 10–11 (intro-once, polling-first sockets) are ours.

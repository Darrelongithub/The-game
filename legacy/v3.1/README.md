# `legacy/v3.1/` — the line `main` shipped, kept in the tree

**Nothing in this directory runs.** It is not imported by the server, the web app,
the engine, the tests or the build. It exists so that merging the v3.2 rebuild
into the branch deletes no work: every file the v3.1 line authored is here,
verbatim, at its original path.

## Why it is parked and not wired

v3.2 (the GAME BRIEF the branch is building to) replaced the *shape* of the
game, not just its copy:

| v3.1 line (here) | v3.2 (live) |
|---|---|
| rounds with a `phase` (`warmup/spicy/deep/dare`) and `ROUND_MIX` | 12 **cases** of 7 segment shapes, `BANDS` per prompt |
| `heat` score, `HeatPhase`, `DARE_ROUNDS` | no heat number; `dare` is a case kind with a real decline path |
| `confession` / `ios` / `shout` / `minigame` / `pair_dare` answer kinds | `pick / text / longtext / rating / dare / pair_vote / pair_pick` |
| Grok (`XAI_API_KEY`) generation lane + `GEN_*` | Ollama lane (`GEN_BASE`/`GEN_MODEL`, no key) + a Gemini analysis lane |
| per-round reveals, `REVEAL_MODE`, `*.reveals.log`, the display queue | one reveal at the end, `FinaleView`, plus a `reveal` copy lane |
| bank: 5 files, `SPICY_TIER`, `filter.ts` | bank: 194 hand-written entries in 5 bands, every one feeding a metric |
| `Director`/`director.ts` live-moment scheduler | the case planner in `apps/server/src/game.ts` |

The two cannot both be the running game: they disagree about what a round *is*.
So the merge takes v3.2's shape for the spine, keeps everything v3.1 authored
here, and — see `NOTES/merge-v31-into-v32.md` — ports the parts that were never
about the shape at all.

## Re-adopting a file

1. Move it back to the path it has here (`git mv legacy/v3.1/<path> <path>`).
2. Re-point the npm script that used it (see the "unwired" section of the merge note).
3. Expect the contract fields it reads to be gone — the port is the work, not the move.

Contents: 54 files, 10756 lines.

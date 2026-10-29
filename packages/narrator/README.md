# `@reveal/narrator` — Agent E

The finale's brain: a **pure** public skeleton, **one** Gemini call to polish it,
a validator that gates every model string, and Secret Decks that only ever
reach the owning phone.

```
buildSkeleton(results, digest, roster?)            // pure, no I/O, deterministic
writeFinale(skeleton, decks, results, digest, o?)  // ONE provider call, never throws
narrateNight({ results, digest, decks, roster })   // both, in one call
```

## For the server (Agent F)

```ts
import {
  buildSkeleton, writeFinale, applyAliasesToSlides, applyAliasesToDecks,
} from "@reveal/narrator";

const roster = room.meta.players;                       // [{ id, alias }] join order
const skeleton = buildSkeleton(results, digest, roster); // ⚠ pass the roster
const { slides, decks } = await writeFinale(
  skeleton, secrets, results, digest, { roster },       // secrets = engine.buildSecrets()
);

io.emit("finale", { slides: applyAliasesToSlides(slides, roster), summary });
for (const [playerId, cards] of decks) {
  socketOf(playerId).emit("secrets", { cards: applyAliasesToDecks(new Map([[playerId, cards]]), roster).get(playerId)! });
}
```

- **Pass `roster`** (a `RoomMeta`, or `meta.players`, or `{ id, alias }[]`). The
  digest is keyed by **alias** (`quotes`, `dodges`, `stats`), claims are keyed by
  **PlayerId**. Without the roster the narrator refuses to guess and drops the
  digest attributions ("— Player 2") instead of misattributing them. Everything
  else still renders. This is also requested in `NOTES/contract - requests.md`.
- `slides` are **broadcast-safe**: public claim types only, `Player N` tokens
  only, identical on every phone. `onesided` / `spark` claims can never appear.
- `decks` are **per player**: emit each deck on that player's socket only, never
  broadcast, never persist with the room, never put in the share card.
- `applyAliasesToSlides` / `applyAliasesToDecks` do the deterministic
  `"Player N"` → alias swap (longest token first, so `Player 10` is safe).
- The narrator makes **at most one** provider call per night (of the
  `MAX_PROVIDER_CALLS_PER_NIGHT` budget) and never calls Grok.

## Slide order (spec §7)

```
title
besties   tease → escalate → land
rivals
consensus (flavor "group", claim.numbers untouched)
blind spots (≤ 3)
QUOTE OF THE NIGHT (flavor "quote", verbatim)
DODGE REPORT × n (flavor "dodge", every excuse verbatim, ≤ 6)
SPEED RUNNER (flavor "stat", numbers.ms)
CONTRADICTION WATCH (flavor "stat", derived from digest stats)
toxic (flavor "group", land beat)
SHIP      tease → escalate → land   ← biggest
free agent (odd n only, own slide)
THAT'S THE NIGHT
```

`numbers` on a slide are copied from the claim untouched (`votes` / `of` /
`share` for consensus, `percentile` / `nominations` for toxic) — B2's Group
Announcement animates them; nothing is ever recomputed here.

## Degradation

| situation | result |
|---|---|
| no `GEMINI_API_KEY` | engine skeleton + engine decks, byte for byte |
| timeout (10 s), 429, network error | same |
| endpoint rejects the safety field (400) | retries once with the literal `SAFETY_OFF` values, then falls back |
| junk JSON, prose refusal, empty text | same |
| one bad slide / card | that slide/card keeps the engine line; the rest merge |

Never throws, never returns empty text, never blocks the show.

## Validation (every model string, slides **and** card facts)

- digits must already exist in that slide's `numbers` or its engine text —
  `Player 3` is a label, not a number;
- players only as `Player \d+`, inside the roster, and only if they are on that
  slide (`Player One`, `Player Eric`, `Player 12` are rejected);
- no real alias may appear in narration copy;
- banned: `toxic person`, `red flag`, `soulmate`, `science says`,
  `love language`, `diagnos*`, `narcissis*`, `therapy` + clinical extensions;
- title ≤ 6 words, body ≤ 140 chars, card fact ≤ 120 chars, 1–4 facts per card;
- no refusals pretending to be copy;
- quoted material stays verbatim: a QUOTE OF THE NIGHT / Dodge Report body that
  no longer contains the digest text is an invented quote and falls back.

A rejected string falls back to the engine's own line — traceable to
claims/digest by construction.

## Model payload

`night` (tone) + `claims` (public claims referenced by slides) + `digest`
(pseudonymized: quotes/dodges/stats/selfVsRoom, aliases scrubbed — including
aliases a player typed into an answer) + `slides` (beat, flavor, players,
numbers, engine copy, verbatim material) + `secretCards` (engine title/facts).

## Tests

```bash
npm test                                   # node --test (Node ≥ 22.18, native TS)
node --import tsx --test test/*.test.ts     # Node 20 / repo convention
npm run typecheck                          # tsc --noEmit, strict
```

86 tests, zero network: the fetch is always mocked.

## Known gaps

- `SPEED RUNNER` uses `digest.stats.fastest`, which is all-night fastest. The
  scope asks for "fastest on spicy+ rounds"; the digest carries no phase split
  (contract request filed).
- `CONTRADICTION WATCH` is derived from `stats.topDodger` + `selfVsRoom`, since
  `NightDigest` has no `contradictions` field (contract request filed).
- Model copy is merged by array index — the skeleton order is stable, but a
  stable `FinaleSlide.id` would be safer (contract request filed).

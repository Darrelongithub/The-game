# The Unhinged Tier — u1–u27 (SPICY_TIER only)

Rules that govern this file:
- Included in the bank ONLY when `SPICY_TIER=true` (private, 18+, consenting
  friend group). Filtered out otherwise — the game stays fully playable.
- BANK-ONLY content: these prompts are served locally and are NEVER sent to
  any provider. Providers only ever see pseudonymized digest data for
  callbacks/analysis.
- Same mechanics as every other prompt: "I can't" + verbatim reason is
  always available; no player is ever forced.
- Boundaries: adults only, nothing non-consensual, nothing illegal, nobody
  outside the room, no real-person sexual likenesses.
- Dares are SOCIAL-RISK only (embarrassment, reveals, cringe) — never
  physical danger, never illegal.
- **DATA-OR-DEAD RULE (the point of this file):** every entry is directed at
  someone IN THIS ROOM (or a pair) and carries a coding + measures that feed
  the engine — picks → overlap/mutual/consensus/one-sided; peer ratings →
  trait agreement + blind spots; ios → closeness; texts about room members →
  contempt/affection tags + verbatim quote material; dares → compliance +
  pass reasons tied to a directed target (doing something risky FOR or WITH
  a specific person is a trust/couple signal); pair_dare → debrief
  similarity. Random spectacle is banned — if it measures nothing, it
  doesn't ship. Same rule as spec §6.
- Placeholders {P1}..{P11} are substituted server-side for display only.
- Host may delete any prompt at request time; `delete_room` nukes everything.

Format: `id | phase | kind | coding | asksTarget | measures`.

## Spicy picks & questions (u1–u10)
- u1 | spicy | pick | couple | yes | directed desire signal
  "Who in this room have you had a dream about that you'd never admit to? Point."
- u2 | spicy | rating | friction | peer | spice traitAgreement + blind spot
  "Rate {P2}'s freakiness 1–10. Pray they rate you back."
- u3 | spicy | pick | couple | yes | couple-coding seed
  "If you HAD to pick a drunk make-out partner from this room, who's the
  safest bet? Point."
- u4 | spicy | rating | couple | peer | dyadic perception gap (one-sided fuel)
  "Rate {P3}'s flirty energy toward YOU specifically, 1–10."
- u5 | spicy | text | friction | about a room member | desire tags + named target
  "What's something someone in this room does that accidentally turns you on?
  You'll end up naming them anyway."
- u6 | spicy | pick | rivalry | yes | rivalry + threat consensus
  "Who here could steal your partner in under an hour? Point at the threat."
- u7 | spicy | ios | couple | peer | closeness map under spicy pressure
  "How close are you and {P4} really? Circles — and the room can see you thinking."
- u8 | spicy | pick | friction | yes | pick cluster / consensus
  "Who here has the most sexual tension with someone ELSE in this room? Point."
- u9 | spicy | rating | friction | peer | directed perception
  "Rate how well {P5} hides their crushes, 1–10."
- u10 | spicy | pick | couple | yes | couple pick, high signal
  "Who in this room would you genuinely risk it all for? Point. No context
  will be provided."

## Deep-spicy (u11–u18)
- u11 | deep | text | friction | about a room member | grievance tags, dyadic
  "What's a line someone in this room crossed with you that you never
  brought up?"
- u12 | deep | pick | trust | yes | trust/closeness map
  "Who here knows something about your sex life that nobody else does? Point."
- u13 | deep | pick | trust | yes | confidant map
  "Who's the first person in this room you'd tell about a wild hookup? Point."
- u14 | deep | text | trust | self + room | vulnerability, room-referenced
  "What's something sexual you're insecure about that someone here has
  probably already guessed?"
- u15 | deep | rating | friction | peer | peer rating, finale-visible
  "Rate {P6}'s rizz 1–10. They will see this at the finale."
- u16 | deep | pick | friction | yes | status / flirt-pattern
  "Who here flirts with everyone but would panic if it actually worked? Point."
- u17 | deep | ios | couple | peer | closeness under pressure
  "Be honest: how close are you and {P7} ACTUALLY? Circles. No rounding down."
- u18 | deep | text | couple | about a room member | dyadic confession, quote material
  "Describe the most charged moment between you and someone in this room.
  One sentence. They'll know it's them."

## Dares — directed, social-risk only (u19–u27)
Every dare names a target ({P}) — compliance/pass-reason IS the data.
- u19 | dare | dare | trust | {P1}-directed | dyadic transparency compliance
  "Let {P1} read your last 3 DMs with them. Out loud. Together."
- u20 | dare | dare | couple | {P2}-directed | dyadic flirt compliance
  "Whisper the most inappropriate compliment you can get away with into
  {P2}'s ear. The room watches their face."
- u21 | dare | dare | trust | {P3}-directed | trust-in-agent compliance
  "Text your most recent ex 'thinking of you' — but {P3} types it and hits
  send."
- u22 | dare | dare | friction | {P4}-directed | directed roast, verbatim
  "Give a 30-second presentation on why {P4} is the most dangerous person in
  this room. Evidence required."
- u23 | dare | dare | couple | {P5}-directed | dyadic tension compliance
  "Maintain eye contact with {P5} for 60 seconds. Laugh and you both
  restart — closer."
- u24 | dare | dare | trust | {P6}-directed | trust compliance (strongest)
  "Hand {P6} your unlocked phone for 60 seconds. No supervision. They may
  not open anything. Allegedly."
- u25 | dare | dare | friction | {P7}-directed | directed, taggable roast
  "Say the nastiest thing you can to {P7} that's still technically a
  compliment."
- u26 | dare | dare | couple | {P8}-directed | confession or memorable pass
  "Tell {P8} the exact moment you realized they were your type — or pass
  with a reason the room will remember."
- u27 | dare | pair_dare | couple | the pair | debrief similarity (big pair signal)
  "You two. Five minutes alone. The group votes first: 'just talking' or
  'not just talking'."

# Research Brief — core extract (verified Oct 2026)

Everything here is verified fact or sourced method. Agents cite this file,
never their own memory of "how APIs work". §1 seeds the fallback bank.

## 1. The 40 seed prompts (bank starters)

Format per entry: `id | phase | kind | coding | asksTarget | measures`.
Placeholders {P1}..{P11} are substituted server-side for display only.
**Every prompt extracts data**: directed at someone in the room (or a pair),
coded, with measures that feed the engine. Random spectacle is banned
(spec §6, the data-or-dead rule). Avoid the banned patterns (favorites,
zombies, desert island, untwisted "most likely to", generic icebreakers).

### Warmup (10)
- w1 | warmup | pick | friendship | yes | early-favorite signals
  "Who here would survive the longest in a horror movie? Point at them."
- w2 | warmup | pick | status | yes | status reads
  "Who's getting us lost on the road trip? Point."
- w3 | warmup | text | neutral | no | chaos baseline
  "Most chaotic thing you did this year. No context needed."
- w4 | warmup | pick | friction | yes | teasing baseline
  "Who would forget their own birthday? Point."
- w5 | warmup | rating | neutral | self | self-image baseline
  "How warm are you, honestly? 1–10."
- w6 | warmup | shout | neutral | no | group vibe snapshot
  "One word for this group's energy tonight."
- w7 | warmup | pick | friendship | yes | trust network
  "First person you'd call with good news? Point."
- w8 | warmup | text | trust | no | values reveal
  "What's a hill you'd die on that everyone here finds ridiculous?"
- w9 | warmup | rating | friction | peer | peer chaos read
  "Rate {P2}'s chaos level 1–10. They can take it."
- w10 | warmup | minigame | neutral | no | tap-war warmup
  "Tap war: fastest fingers wins. Ready…"

### Spicy (10)
- s1 | spicy | pick | status | yes | social awareness
  "Who's been performing calm all night? Point at the best actor."
- s2 | spicy | pick | friction | yes | flirt-pattern signal
  "Who flirts their way out of trouble? Point."
- s3 | spicy | text | friction | about a room member | past-meets-present tags
  "What did you hear about someone in this room BEFORE you met them?"
- s4 | spicy | rating | neutral | self | self-spice baseline
  "How spicy are you, really? 1–10."
- s5 | spicy | pick | couple | yes | couple-coding seed
  "Two people here must date to survive the apocalypse. Point at one of them."
- s6 | spicy | text | friction | about a room member | first-impression tags
  "Your worst first-impression moment involving someone in this room. Go."
- s7 | spicy | pick | rivalry | yes | rivalry seed
  "Who wins a staring contest against you? Point at your rival."
- s8 | spicy | ios | friendship | peer | closeness map
  "How close are you and {P3}, really? Circles."
- s9 | spicy | pick | status | yes | rizz ranking
  "Who here has the most rizz and is wasting it? Point."
- s10 | spicy | text | friction | about a room member | harmless-confession tags
  "Last lie you told to dodge plans with someone in this room. What did you say?"

### Deep (10)
- d1 | deep | text | trust | no | vulnerability
  "What do people misunderstand about you in the first five minutes?"
- d2 | deep | ios | trust | peer | trust map
  "Pick the person you trust most in this room. Circles."
- d3 | deep | rating | neutral | self | honesty self-check
  "How honest have you been tonight? 1–10."
- d4 | deep | text | trust | no | hidden pride
  "What are you proud of that you never get to mention?"
- d5 | deep | pick | friendship | yes | growth witness
  "Who here has changed the most since you met them? Point."
- d6 | deep | text | trust | no | fear reveal
  "A fear you've never said out loud in this group."
- d7 | deep | rating | friction | peer | peer warmth read
  "Rate {P4}'s warmth 1–10. They'll see it eventually."
- d8 | deep | text | friendship | no | group history
  "When did this group last genuinely surprise you?"
- d9 | deep | ios | couple | peer | trajectory
  "Where do you actually want to be with {P5} a year from now? Circles."
- d10 | deep | text | friendship | no | gratitude
  "Kindest thing someone here has ever done for you."

### Dare (10) — every dare names a target; compliance/pass-reason IS the data
- dd1 | dare | dare | trust | {P1}-directed | trust compliance
  "Let {P1} post one story from your gallery. They pick; you get one veto."
- dd2 | dare | dare | friendship | {P2}-directed | affection compliance
  "Compliment {P2} three times, no repeats. The room grades sincerity out loud."
- dd3 | dare | dare | friendship | {P3}-directed | affectionate roast, verbatim
  "Do your best impression of {P3} until someone laughs."
- dd4 | dare | dare | friction | {P4}-directed | dyadic transparency
  "Read the last 3 messages between you and {P4} out loud."
- dd5 | dare | pair_dare | couple | the pair | debrief similarity
  "You two: five minutes alone. Everyone else guesses what you talked about."
- dd6 | dare | dare | friendship | {P5}-directed | sincerity under pressure
  "30-second toast to {P5}. Mean it."
- dd7 | dare | dare | status | {P6}-directed | directed roast-lite
  "Show the last photo you took of yourself — {P6} captions it out loud."
- dd8 | dare | dare | friction | {P7}-directed | honesty to face, tags both ways
  "Say the nicest and the meanest TRUE thing about {P7} — to their face."
- dd9 | dare | debrief | couple | the pair | pair debrief
  (follows dd5) "Separately: what did you two actually talk about?"
- dd10 | dare | dare | status | everyone | status ranking, defends live
  "Rank everyone here by who survives longest in prison. Out loud. Defend it."

## 2. Provider facts (verified Oct 2026)
### Grok (xAI) — unhinged generation lane
- OpenAI-compatible REST: `POST https://api.x.ai/v1/chat/completions`,
  Bearer `XAI_API_KEY`. JSON output via `response_format` if supported —
  else strict-parse a JSON code fence.
- `grok-4-1-fast`: $0.20 in / $0.50 out per 1M tokens, 2M context. Prices
  double for prompts >200K tokens. Automatic prompt caching. VERIFY model
  ids at docs.x.ai/docs/models before wiring.
- Rate tiers: ~100 req/min standard, ~1,000 premium; ~10M tokens/month
  standard quota.
- Policy (x.ai/legal/acceptable-use-policy): envelope ≈ "R-rated movie" —
  sexual situations in text, coarse language, adult/taboo fiction PERMITTED;
  hard blocks everywhere: explicit sexual acts, minors/CSAM (NCMEC
  reporting), real-person pornographic likenesses, non-consent. No
  per-category safety knobs on the API; enforcement occasionally over-blocks
  keywords — the bank fallback absorbs any refusal.
### Gemini — analysis + narration lane
- Key: aistudio.google.com/apikey. Classic REST `generateContent`.
- `gemini-3.5-flash-lite` ≈ $0.30/$2.50 per 1M; `gemini-3.1-pro` ≈ $2/$12.
  Free tier trains on your data — use a paid key for anything touching
  friend data.
- Four adjustable safety categories; set all to the most permissive
  threshold the endpoint accepts ("OFF" on the new interactions API,
  "BLOCK_NONE" on classic v1beta). Core harms stay blocked regardless.
  Expect soft refusals on spicy GENERATION — that's why Gemini never writes
  game prompts.
### Cost model
- One night, worst case, both keys: 4 generation batches + 1 tag batch +
  1 debrief batch + 1 reveal+secrets ≈ 7 calls ≈ under $0.05. Bank-only
  nights: $0.

## 3. Scoring & psychology (what the formulas are built on)
- Kenny's Social Relations Model: any directed rating mixes actor + partner +
  relationship effects — why public claims need peer consensus across
  multiple signal types.
- Vazire SOKA model: self-ratings track observable traits, peers track
  evaluative ones — why blind spots use evaluative traits only (loyalty,
  chaos, reliability, warmth, honesty, spice).
- Inclusion of Other in the Self (Aron 1992): the 7-circle IOS scale — our
  ios round, scored /14 for a pair.
- Bukowski Friendship Qualities Scale: companionship/help/security/closeness
  — the friend-coding tag map.
- Reis & Shaver responsiveness: feeling understood/validated/cared-for —
  the deep-tier themes.
- Aron 1997 self-expansion: escalation + novelty + mild arousal → bonding —
  the heat ladder and dare design.
- Gottman: contempt is the one reliable relational poison — the only tag
  that feeds "most toxic", with the joker guard against one-note pickers.
- Stable-roommates/matching: no shortcut beats brute force at n≤12
  (≤10,395 matchings) — so we brute-force, deterministically.

## 4. UX patterns
- Jackbox: everyone needs their own device; yes-and the audience; the host
  needs controls but shouldn't be the bottleneck.
- WNRS: 3 explicit levels — the heat ladder.
- Spotify Wrapped: ONE stat per screen, reveal rhythm — the finale.
- View Transitions API ≈92% support — progressive enhancement only.

## 5. Infra (Kenya/Nairobi)
- Supabase has NO Africa region — banned for realtime.
- Firestore has africa-south1; Vultr Johannesburg $6/mo is the proper home.
- Cloudflare has Nairobi + Mombasa PoPs.
- v1 needs no realtime platform: one Node server + socket.io on a $6 VPS
  (or free Render/Railway) is plenty for 11 players. Game night itself is
  pure LAN — zero internet required after install.

## 6. Kenya data protection (why the 48h purge is non-negotiable)
- Opinions about a person ARE personal data under the Kenya DPA.
- Sexual life = sensitive personal data (higher standard of care).
- Cross-border transfer rules (s.48/49) apply to foreign LLM calls —
  pseudonyms only ("Player N") is the mitigation.
- Breach notification within 72h; fines up to KES 5M or 1% of turnover.
- Unverified whether "one serving copy in Kenya" is required — treat it as
  yes (the JSONL log lives with the server).

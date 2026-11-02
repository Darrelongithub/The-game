#!/usr/bin/env node
// scripts/gen-voice-probe.mjs
// CAN THE LOCAL MODEL SWITCH REGISTERS?
//
// The gen lane has TWO voices on day one: the group voice ("Who here…" — the
// room's perception) and the confession voice ("Have you ever…" — reality,
// self-report). A register taught without examples produces off-voice output,
// so this probe swaps the EXAMPLES BLOCK of one identical system prompt and
// checks whether the model follows it — before any game code depends on it.
//
// Run it where the local model actually lives (Ollama on the host):
//   GEN_BASE=http://127.0.0.1:11434/v1 GEN_MODEL=dolphin3 node scripts/gen-voice-probe.mjs
//
// Exit codes: 0 = both registers switched, 1 = the model drifted off-voice,
//             2 = the endpoint was unreachable from this machine.
const GEN_BASE = (process.env.GEN_BASE || "http://127.0.0.1:11434/v1").replace(/\/+$/u, "");
const GEN_MODEL = process.env.GEN_MODEL || "dolphin3";

const GROUP_EXAMPLES = [
  "Who here would you have sex with if the world was ending tonight?",
  "Which of you is undressing someone with their eyes right now?",
];
const CONFESS_EXAMPLES = [
  "Have you ever sent a nude to someone in this room?",
  "Have you ever fantasized about someone else in this room?",
];

const HEADER = [
  "You write prompts for a private 18+ party game played by a group of friends in one room.",
  "Phase: spicy. Spicy: flirty, teasing, status and desire reads. Adult banter inside an R-rated envelope.",
  "There are exactly 7 players, addressed only as Player 1..Player 7 — never real names.",
  "Return ONE JSON array of 3 objects. No prose, no markdown.",
];

const SCHEMA = [
  "Each object:",
  '  "text": string, 20-160 characters, second person, a single question,',
  '  "style": "group" or "confess",',
  '  "kind": "pick" (group prompts) or "confess" (confession prompts),',
  '  "coding": one of: couple, friendship, trust, friction, rivalry, status, neutral,',
  '  "measures": string[] with 1-3 short signal names,',
  '  "asksTarget": boolean (true for a group pick; false for a confession).',
  "BANNED: minors, non-consent, explicit sexual acts, real people, illegal acts.",
];

const buildSystem = (voice) => {
  const block = voice === "group"
    ? [
        'VOICE: GROUP ("style":"group"). Addressed to the room; the player names someone else. Start with "Who here".',
        "Examples of the exact register — group voice:",
        ...GROUP_EXAMPLES.map((t) => `  - "${t}"`),
        'Every object must have "style":"group", "kind":"pick", "asksTarget":true.',
      ]
    : [
        'VOICE: CONFESSION ("style":"confess"). Second person, self-report: the player answers about THEMSELVES,',
        'privately, yes/no. Start with "Have you ever". There is NO skip option.',
        "Examples of the exact register — confession voice:",
        ...CONFESS_EXAMPLES.map((t) => `  - "${t}"`),
        'Every object must have "style":"confess", "kind":"confess", "asksTarget":false.',
      ];
  return [...HEADER, ...block, ...SCHEMA].join("\n");
};

const callModel = async (voice) => {
  const body = {
    model: GEN_MODEL,
    temperature: 0.9,
    messages: [
      { role: "system", content: buildSystem(voice) },
      { role: "user", content: JSON.stringify({ phase: "spicy", players: 7, count: 3, voice }) },
    ],
  };
  const started = Date.now();
  const response = await fetch(`${GEN_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(process.env.GEN_KEY ? { authorization: `Bearer ${process.env.GEN_KEY}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  const content = json?.choices?.[0]?.message?.content ?? json?.message?.content ?? "";
  return { content: String(content), ms: Date.now() - started };
};

/** Which register does the raw reply actually speak? (crude, deterministic) */
const detectVoice = (content) => {
  let parsed = null;
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try { parsed = JSON.parse(content.slice(start, end + 1)); } catch { parsed = null; }
  }
  const texts = Array.isArray(parsed)
    ? parsed.map((row) => (typeof row?.text === "string" ? row.text : "")).filter(Boolean)
    : content.split(/\n+/u).map((line) => line.replace(/^[\s\-*\d."]+/u, "").trim()).filter((line) => line.length > 12);
  const confess = texts.filter((t) => /^have\s+you\s+ever\b/iu.test(t)).length;
  const group = texts.filter((t) => /^(who\s+here|which\s+of\s+you|point\s+at|who\b)/iu.test(t)).length;
  return { items: texts.length, confess, group, parses: Array.isArray(parsed), texts };
};

const main = async () => {
  console.log(`gen-voice-probe → ${GEN_MODEL} @ ${GEN_BASE}`);
  const results = {};
  for (const voice of ["group", "confess"]) {
    try {
      const reply = await callModel(voice);
      const detected = detectVoice(reply.content);
      results[voice] = { ...reply, detected };
      console.log(`\n=== asked for ${voice.toUpperCase()} voice (${reply.ms} ms, parses=${detected.parses}) ===`);
      console.log(`items=${detected.items} group-shaped=${detected.group} confess-shaped=${detected.confess}`);
      detected.texts.slice(0, 3).forEach((t) => console.log(`  - ${t.slice(0, 140)}`));
    } catch (error) {
      results[voice] = { error: String(error?.message ?? error) };
      console.log(`\n=== ${voice.toUpperCase()} voice FAILED: ${results[voice].error} ===`);
    }
  }
  const unreachable = Object.values(results).every((r) => typeof r.error === "string");
  if (unreachable) {
    console.log("\nUNREACHABLE: no local model answered. Start Ollama on the host (`ollama serve`, `ollama pull dolphin3`),");
    console.log("then re-run: GEN_BASE=http://127.0.0.1:11434/v1 GEN_MODEL=dolphin3 node scripts/gen-voice-probe.mjs");
    process.exit(2);
  }
  const groupOk = (results.group?.detected?.group ?? 0) >= 1;
  const confessOk = (results.confess?.detected?.confess ?? 0) >= 1;
  console.log(`\nregister switch: group=${groupOk ? "OK" : "DRIFTED"} confess=${confessOk ? "OK" : "DRIFTED"}`);
  process.exit(groupOk && confessOk ? 0 : 1);
};

await main();

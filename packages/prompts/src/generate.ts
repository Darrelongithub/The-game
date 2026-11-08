// packages/prompts/src/generate.ts
// THE NIGHT'S CONTENT — Ollama writes all of it.
//
// There is no bank fallback in a production night. Every question the room
// sees — subject, observer, solo, ship vote, best couple, dare and the
// look-chain copy — is generated here from a role brief. The bank remains in
// the repository for tests and for the explicit offline provider, never for a
// real room.
//
// The run is role-planned: the generator knows how many questions the case
// engine will ask for each role tonight, asks for that many (plus a small
// buffer), validates every line against the role's slot contract, and reports
// shortfalls instead of quietly filling them from the bank.
import {
    CASES_PER_NIGHT,
    MAX_PROMPT_CHARS,
    METRIC,
    type Band,
    type MetricKey,
    type Prompt,
    type PromptCoding,
    type PromptRole,
    type RoundKind,
    type TraitId,
} from "../../shared/src/contracts.ts";
import { placeholderIndexes } from "./bank/index.ts";
import {
    GEN_SAFETY_CAP_MS,
    GEN_TARGET_PROMPTS,
    OLLAMA_DEFAULT_MODEL,
    type OllamaConfig,
    type OllamaFetch,
    callOllama,
    isMetaCommentary,
    isRefusal,
    normalizeForMatch,
    ollamaConfig,
} from "./ollama.ts";

export class GenerationError extends Error {
    constructor(message: string, readonly missing: string[] = []) {
        super(message);
        this.name = "GenerationError";
    }
}

export interface NightChain {
    announce: string;
    act: string;
    guess: string;
    why: string;
    source: "ollama";
}

export interface GenerationBatch {
    label: string;
    asked: number;
    accepted: number;
    dropped: number;
    reasons: Record<string, number>;
}

export interface GenerateBatchInput {
    playerCount: number;
    seed: number;
    room?: string;
    aliases?: readonly string[];
    config?: Partial<OllamaConfig>;
    fetchImpl?: OllamaFetch | null;
    now?: () => number;
    safetyCapMs?: number;
    log?: (line: string) => void;
    onProgress?: (ready: number) => void;
}

export interface GenerateBatchReport {
    /** Every prompt to play. All of them have `source: "ollama"`. */
    prompts: Prompt[];
    /** The look-chain flavours, one per chain tonight. */
    chains: NightChain[];
    /** The best-couple question (a `pair_pick` for the group). */
    bestCouple?: Prompt;
    /** One watcher template per dare: `{P1}` and `{P2}` are the targets. */
    watchers: Prompt[];
    batches: GenerationBatch[];
    accepted: number;
    dropped: number;
    capped: boolean;
    offline: boolean;
    target: number;
    /** Set when the night cannot be played. The caller must not start. */
    error?: string;
    missing: string[];
}

type SlotRule = "none" | "never" | "any" | "p1" | "p1p2";

interface PromptPlan {
    key: string;
    role: PromptRole;
    band: Band;
    required: number;
    count: number;
    kinds: readonly RoundKind[];
    fixedKind?: RoundKind;
    slotRule: SlotRule;
    brief: string;
    /** Signals the model should try to cover, so the reveal has data. */
    metricGoals?: readonly MetricKey[];
}

/** How many ordinary cases the night runs for this room size. */
function ordinaryCasesFor(playerCount: number): number {
    if (playerCount <= 4) return CASES_PER_NIGHT - 2;
    if (playerCount >= 11) return CASES_PER_NIGHT;
    return CASES_PER_NIGHT - 1;
}

function pairsPerCase(playerCount: number): number {
    return Math.max(1, Math.floor((playerCount - 1) / 2));
}

function shipVotesFor(playerCount: number): number {
    return Math.max(1, Math.min(3, playerCount - 2));
}

function daresFor(playerCount: number): number {
    return Math.max(1, Math.min(2, playerCount - 3));
}

function chainsFor(playerCount: number): number {
    if (playerCount >= 11) return 8;
    if (playerCount >= 8) return 7;
    return 6;
}

/**
 * The exact question needs for tonight. `required` is what the case engine
 * will draw; `count` adds a small buffer for lines the model loses to repeats.
 */
export function planNight(playerCount: number): PromptPlan[] {
    const ordinary = ordinaryCasesFor(playerCount);
    const observerTotal = ordinary * pairsPerCase(playerCount);
    // buildCase alternates pair prompts from the SECOND pair onward, so the
    // split is floor(pairs / 2), not a 50/50 guess.
    const observerPair = ordinary * Math.floor(pairsPerCase(playerCount) / 2);
    const observerSubject = observerTotal - observerPair;
    // An even room has an odd number of observers, so EVERY ordinary case
    // leaves one player over. That seat needs its own solo question each time,
    // not once a night; without this the leftover sat idle from case 2 onward.
    const solo = playerCount % 2 === 0 ? ordinary : 0;
    const ships = shipVotesFor(playerCount);
    const dares = daresFor(playerCount);

    const plans: PromptPlan[] = [
        {
            key: "subject",
            role: "subject",
            band: "spicy",
            required: ordinary,
            count: ordinary + 2,
            kinds: ["pick", "rating", "text"],
            slotRule: "never",
            brief: "The phone reading this belongs to the subject. Write to \"you\". Ask a filthy, specific question about their own desire, body count, a secret, cheating, or who in this room they want. Do NOT use {P1} slots and never name the subject; say \"someone in this room\" when you need a target. No safe personality questions.",
            metricGoals: ["body-count", "sex-desire", "best-in-bed", "trust", "crush", "is-fake", "liar", "weirdest", "ex", "money"] as MetricKey[],
        },
        {
            key: "observer-subject",
            role: "observer_subject",
            band: "spicy",
            required: observerSubject,
            count: observerSubject + 2,
            kinds: ["pick", "rating", "text"],
            slotRule: "p1",
            brief: "An observer pair reads this about {P1}, another player in the room. Ask something spicy and specific about {P1}: who they would sleep with, whether they would cheat, their body count, or the secret they are hiding. The question must be about {P1}. Use {P1} literally; {P2} and up may be other people. Never write a real name.",
            metricGoals: ["would-cheat", "would-snitch", "body-count", "best-in-bed", "sex-desire", "trust", "liar", "betrayal", "is-fake", "crush"] as MetricKey[],
        },
        {
            key: "observer-pair",
            role: "observer_pair",
            band: "deep",
            required: observerPair,
            count: observerPair + 2,
            kinds: ["text", "pick"],
            fixedKind: "text",
            slotRule: "p1p2",
            brief: "An observer pair reads this about two other people, {P1} and {P2}. Ask a spicy prediction: who would cheat first, who is secretly into whom, who would be the hottest couple, or what they would do behind someone's back. It must include both slots. Ask for a short opinion or prediction, not a rating.",
            metricGoals: ["couple-fit", "would-cheat", "trust"] as MetricKey[],
        },
        {
            key: "solo",
            role: "solo",
            band: "spicy",
            required: solo,
            count: solo + 2,
            kinds: ["text"],
            fixedKind: "text",
            slotRule: "never",
            brief: "One person reads this alone. Ask a filthy, personal confession or desire question to \"you\": sex, cheating, a secret crush, the last person they thought about naked. Do NOT use {P1} slots and do not name anyone. No safe questions.",
        },
        {
            key: "ship-vote",
            role: "group",
            band: "spicy",
            required: ships,
            count: ships + 1,
            kinds: ["pair_vote"],
            fixedKind: "pair_vote",
            slotRule: "p1p2",
            brief: "The whole room votes on a hypothetical couple, {P1} and {P2}. Ask whether they would be a hot couple, who would cheat first, who would top, or how long they would last. Include both slots and make it spicy.",
            metricGoals: ["gay-hypothetical", "couple-fit", "best-in-bed"] as MetricKey[],
        },
        {
            key: "best-couple",
            role: "group",
            band: "spicy",
            required: 1,
            count: 2,
            kinds: ["pair_pick"],
            fixedKind: "pair_pick",
            slotRule: "never",
            brief: "The whole room picks the best couple from a list of pairs, but make the question filthy: most likely to hook up, best sex, most likely to cheat, or the couple that would break the group. Write one question. Do NOT use any {P1} slots; the list of pairs is supplied by the app.",
        },
        {
            key: "dare",
            role: "dare",
            band: "dare",
            required: dares,
            count: dares + 1,
            kinds: ["dare"],
            fixedKind: "dare",
            slotRule: "p1",
            brief: "A single named player is dared. Start the line with {P1}, then give a filthy, funny dare they can do in the room or an explicit confession they must make: send a sext, read their last dirty text, confess who they would sleep with, show their search history. One line. No PG tasks, no 'sing a song'.",
        },
        {
            key: "dare-watch",
            role: "group",
            band: "dare",
            required: dares,
            count: dares + 1,
            kinds: ["text"],
            fixedKind: "text",
            slotRule: "p1p2",
            brief: "The rest of the room reads this about {P1} and {P2}, who were just given a dare. Ask whether they think the two will actually do it, who will chicken out first, and what they are hiding. Include both slots.",
        },
    ];
    return plans;
}

function systemPrompt(): string {
    return [
        "You are the question writer for an adults-only party game played by friends who all know each other.",
        "Every question is original. Never mention the bank, a template, an AI, a policy, or that you are a model.",
        "Be blunt, funny, nosy and filthy. The players are adults and consented to the game.",
        "Every question must be unmistakably adult: sex, desire, cheating, body counts, secrets, jealousy, lies or money. No safe icebreakers, no trivia, no 'favourite colour' questions.",
        "Never write a real person's name. Use the literal slots {P1}, {P2} ... when a question needs a player; the app replaces them.",
        "Output only the requested lines. No numbering, no bullets, no quotes, no explanation.",
        `Each question is at most ${MAX_PROMPT_CHARS} characters.`,
    ].join("\n");
}

function labeledPlan(plan: PromptPlan): boolean {
    return plan.fixedKind === undefined;
}

function userPromptFor(plan: PromptPlan, want: number): string {
    const kindList = plan.kinds.join(", ");
    const lines = [
        `PLAN: ${plan.key}`,
        `ROLE: ${plan.role}`,
        plan.brief,
        `Allowed kinds: ${kindList}.`,
        plan.fixedKind ? `Every line uses kind "${plan.fixedKind}".` : "Choose the kind that fits each line from the allowed list.",
        `Write exactly ${want} lines. Do not write fewer. Do not add notes.`,
        ...(plan.metricGoals?.length
            ? [`If a line measures one of these signals, add "metric" to its JSON: ${plan.metricGoals.join(", ")}. Spread them across the lines.`]
            : []),
        plan.slotRule === "never"
            ? "Do not use any {P1} slots in these lines."
            : plan.slotRule === "p1p2"
                ? "Every line must contain both {P1} and {P2}."
                : plan.slotRule === "p1"
                    ? "Every line must contain {P1}."
                    : "Use a slot only when it makes the question sharper.",
        labeledPlan(plan)
            ? "Return one JSON object per line, exactly: {\"kind\":\"pick\",\"text\":\"...\"}"
            : "Return one JSON object per line, exactly: {\"text\":\"...\"}",
    ];
    return lines.join("\n");
}

interface ParsedLine {
    text: string;
    kind: RoundKind;
    metric?: MetricKey;
}

function cleanLine(raw: string): string {
    return raw
        .replace(/^```(?:json|jsonl)?/i, "")
        .replace(/```$/g, "")
        .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
        .replace(/^\s*#{1,6}\s*/, "")
        .replace(/\*\*|__|`/g, "")
        .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "")
        .trim();
}

function parseGenerated(raw: string, plan: PromptPlan): ParsedLine[] {
    const out: ParsedLine[] = [];
    const text = raw.replace(/^```(?:json|jsonl)?/gim, "").replace(/```/g, "").trim();
    // A model that returns a JSON array is fine too.
    if (text.startsWith("[")) {
        try {
            const array = JSON.parse(text) as unknown;
            if (Array.isArray(array)) {
                for (const item of array) {
                    if (typeof item === "string") {
                        const line = cleanLine(item);
                        if (line) out.push({ text: line, kind: inferKind(line, plan) });
                        continue;
                    }
                    const parsed = objectLine(item, plan);
                    if (parsed) out.push(parsed);
                }
                if (out.length > 0) return out;
            }
        } catch { /* fall through to JSONL */ }
    }
    for (const rawLine of text.split(/\r?\n/)) {
        const line = cleanLine(rawLine);
        if (!line) continue;
        if (line.startsWith("{")) {
            try {
                const parsed = objectLine(JSON.parse(line) as unknown, plan);
                if (parsed) out.push(parsed);
                continue;
            } catch { /* treat it as plain text */ }
        }
        out.push({ text: line.replace(/^["']|["']$/g, "").trim(), kind: inferKind(line, plan) });
    }
    return out;
}

function objectLine(value: unknown, plan: PromptPlan): ParsedLine | null {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const rawText = typeof record.text === "string" ? record.text : typeof record.question === "string" ? record.question : undefined;
    if (!rawText) return null;
    const text = cleanLine(rawText).replace(/^["']|["']$/g, "").trim();
    if (!text) return null;
    const rawKind = typeof record.kind === "string" ? record.kind : "";
    const kind = kindFor(text, rawKind, plan);
    const rawMetric = typeof record.metric === "string" ? record.metric : "";
    const metric = isMetricKey(rawMetric) ? rawMetric : undefined;
    return { text, kind, ...(metric ? { metric } : {}) };
}

const METRIC_KEYS = new Set<string>(Object.values(METRIC));

function isMetricKey(value: string): value is MetricKey {
    return METRIC_KEYS.has(value);
}

function isRoundKind(value: string): value is RoundKind {
    return value === "pick" || value === "text" || value === "longtext" || value === "rating"
        || value === "dare" || value === "pair_vote" || value === "pair_pick";
}

function kindFor(text: string, requested: string, plan: PromptPlan): RoundKind {
    if (plan.fixedKind) return plan.fixedKind;
    // The text wins over a wrong label. A model that calls "Who would you take
    // home?" a text question must still get the picker, and a "Rate ... 1-10"
    // question must still get the 1-10 control.
    const hinted = inferKind(text, plan);
    if (hinted === "pick" || hinted === "rating") return hinted;
    return isRoundKind(requested) && plan.kinds.includes(requested) ? requested : hinted;
}

function inferKind(text: string, plan: PromptPlan): RoundKind {
    if (plan.fixedKind) return plan.fixedKind;
    // "Rate X from 1 to 10" is unambiguous; a question starting with "Who" is a pick.
    if (plan.kinds.includes("rating") && /\b(rate|rating|1\s*(?:to|-)\s*10)\b/i.test(text)) return "rating";
    if (plan.kinds.includes("pick") && /^\s*(?:who|which)\b/i.test(text)) return "pick";
    if (plan.kinds.includes("text")) return "text";
    return plan.kinds[0]!;
}

function inferMetric(text: string): MetricKey | undefined {
    if (/\b(?:were|are|if)\b[^?]*\bgay\b/i.test(text)) return METRIC.gayHypothetical as MetricKey;
    if (/body count/i.test(text)) return METRIC.bodyCount as MetricKey;
    if (/best in bed|good in bed/i.test(text)) return METRIC.bestInBed as MetricKey;
    if (/cheat/i.test(text)) return METRIC.wouldCheat as MetricKey;
    if (/snitch/i.test(text)) return METRIC.wouldSnitch as MetricKey;
    if (/trust/i.test(text)) return METRIC.trust as MetricKey;
    if (/liar|lying|lie\b/i.test(text)) return METRIC.liar as MetricKey;
    if (/betray/i.test(text)) return METRIC.betrayal as MetricKey;
    if (/body|hook\s*up|sleep with|take home|sex|kiss|date/i.test(text)) return METRIC.sexDesire as MetricKey;
    if (/crush/i.test(text)) return METRIC.crush as MetricKey;
    if (/couple/i.test(text)) return METRIC.coupleFit as MetricKey;
    if (/fake/i.test(text)) return METRIC.isFake as MetricKey;
    return undefined;
}

/** A rating needs a trait for the UI and the engine; derive one from the line. */
function inferTrait(metric: MetricKey | undefined, text: string): TraitId {
    if (/spice|sex|kiss|body|desire|hook|sleep|bed|naked|hot|attract/i.test(text)
        || metric === METRIC.sexDesire || metric === METRIC.bestInBed || metric === METRIC.crush) return "spice";
    if (/honest|liar|lie|truth|fake|trust/i.test(text) || metric === METRIC.liar || metric === METRIC.trust) return "honesty";
    if (/loyal|cheat|betray|snitch/i.test(text) || metric === METRIC.wouldCheat || metric === METRIC.betrayal) return "loyalty";
    if (/reliab|depend|late|flaky/i.test(text)) return "reliability";
    if (/warm|kind|friend|nice|care/i.test(text)) return "warmth";
    return "chaos";
}

function codingFor(metric: MetricKey | undefined, text: string): PromptCoding {
    if (metric === METRIC.coupleFit || /couple|kiss|date/i.test(text)) return "couple";
    if (metric === METRIC.trust || /trust/i.test(text)) return "trust";
    if (metric === METRIC.wouldCheat || metric === METRIC.betrayal) return "friction";
    if (/friend/i.test(text)) return "friendship";
    if (/rival|enemy/i.test(text)) return "rivalry";
    if (/famous|popular|status/i.test(text)) return "status";
    return "tease";
}

/**
 * Is this actually adult party content, not a safe icebreaker? The model is
 * told to be filthy; this is the check that stops a bland line slipping into a
 * spicy round. The list is deliberately broad: desire, bodies, cheating,
 * secrets, lies, jealousy, risk and sex-adjacent social heat all count.
 */
const HEAT_PATTERN = /\b(?:sex|sexy|sexual|sexuality|kiss(?:ed|ing)?|ma(?:ke|de|king)\s*out|hook(?:ed|ing)?\s*up|hookup|take\s+home|sleep(?:ing)?\s+(?:with|together)|slept\s+with|body\s*count|naked|nude\w*|nudity|bed|cheat(?:ing|er)?|affair|desire|desirable|crush|attract(?:ed|ion|ive)?|turn(?:s|ed)?[\s-]?on|horny|thirst\w*|date|dating|romance|romantic|love|lover|jealous\w*|ex(?:es)?|secret\w*|lie|liar|lying|betray\w*|loyal\w*|honest\w*|reliab\w*|depend\w*|flaky|warm\w*|chill|calm|drama|messy|wild|unpredict\w*|spont\w*|trust|snitch|toxic|red\s*flag|green\s*flag|fake|two-faced|pretend\w*|weirdest|money|cash|broke|debt|owe|body|text(?:ing|ed)?\s+(?:at\s+)?[23]\s*am|2\s*am|3\s*am|kink\w*|fetish\w*|moan\w*|orgasm\w*|oral|top|bottom|sub|dom|threesome|three-?some|virgin\w*|porn\w*|sext\w*|fuck\w*|smash|bang|flirt\w*|hot|ripped|abs|boobs|ass|dick|cock|pussy|tits|balls|butt|breasts|underwear|shower|bathtub|massage|lap|ride|grind\w*|sneaky\s*link|situationship|ship|chemistry|friend\s+with\s+benefits|fwb|one[-\s]night|naughty|dirty|filth\w*|wild|caught|confess\w*|admit\w*|hid(?:e|ing)|deny|last\s+text|search\s+history|screenshot|inbox|dating\s+app|tinder|bumble|hinge|embarrass\w*|shame\w*|regret\w*|worst\s+thing|illegal|rule\s*break|break\s+the\s+rules|gossip|fight|swinger|orgy|mile\s*high|couple)\b/i;

export function isSpicy(text: string): boolean {
    return HEAT_PATTERN.test(text);
}

/** A dare has a higher bar than a question: it must be actually filthy or risky. */
export function isFilthyDare(text: string): boolean {
    if (!isSpicy(text)) return false;
    return /\b(?:sex|sexy|kiss|hook(?:ed|ing)?\s*up|sleep(?:ing)?\s+(?:with|together)|slept\s+with|naked|nude\w*|body\s*count|cheat|desire|crush|fuck\w*|smash\w*|bang\w*|sext\w*|filth\w*|dirty|horny|thirst\w*|attract\w*|bed|lap|rid(?:e|ing)|grind\w*|porn\w*|orgasm\w*|moan\w*|top|bottom|threesome|three-?some|kink\w*|fetish\w*|underwear|bra|panties|dick|cock|pussy|ass|boobs|tits|balls|nude|orgy|mile\s*high|one[-\s]night|fwb|sneaky\s*link|situationship|risk\w*|secret\w*|search\s*history|screenshot|inbox)\b/i.test(text);
}

/** Roles whose whole point is spice. A tame line is rejected, not played. */
function needsHeat(plan: PromptPlan): boolean {
    return plan.key === "subject"
        || plan.key === "observer-subject"
        || plan.key === "observer-pair"
        || plan.key === "solo"
        || plan.key === "ship-vote"
        || plan.key === "best-couple"
        || plan.key === "dare";
}

function slotCheck(text: string, plan: PromptPlan, playerCount: number): boolean {
    const indexes = placeholderIndexes(text);
    // placeholderIndexes() hides out-of-range slots; inspect the raw text so a
    // generated {P99} can never reach a phone as a literal.
    for (const match of text.matchAll(/\{P(\d+)\}/g)) {
        const n = Number(match[1]);
        if (!Number.isInteger(n) || n < 1 || n > playerCount) return false;
    }
    // Any other brace would reach a phone raw. Only {Pn} is ours.
    if (/[{}]/.test(text.replace(/\{P\d+\}/g, ""))) return false;
    // The best-couple question is followed by a list of pairs; a raw slot in
    // the question itself would leak the placeholder on every phone.
    if (plan.key === "best-couple" && indexes.length > 0) return false;
    if (plan.slotRule === "never") {
        if (indexes.length > 0) return false;
        if (plan.role === "subject" || plan.role === "solo") {
            return /\b(?:you|your|yours|yourself|this room|everyone here|who here)\b/i.test(text);
        }
        return true;
    }
    if (plan.slotRule === "none" || plan.slotRule === "any") {
        // Subject/solo questions are about the person answering. A name slot
        // here would either name the subject on their own phone or point at a
        // person the question did not mean; keep these two roles slot-free.
        if (plan.role === "subject" || plan.role === "solo") {
            if (indexes.length > 0) return false;
            return /\b(?:you|your|yours|yourself|this room|everyone here|who here)\b/i.test(text);
        }
        return true;
    }
    // A single-target dare is delivered with only {P1} bound; a second slot
    // would reach both dared phones as a raw {P2}.
    if (plan.key === "dare") return indexes.length > 0 && indexes.every((i) => i === 1);
    // Pair roles are delivered with exactly two bindings. A third slot would
    // reach the room raw, so reject it here rather than at the phone.
    if (plan.slotRule === "p1p2") {
        return indexes.includes(1) && indexes.includes(2)
            && indexes.every((i) => i === 1 || i === 2);
    }
    if (plan.slotRule === "p1") return indexes.includes(1);
    return false;
}

interface PlanResult {
    prompts: Prompt[];
    asked: number;
    dropped: number;
    reasons: Record<string, number>;
    missing: number;
    offline: boolean;
    capped: boolean;
}

async function runPlan(
    plan: PromptPlan,
    context: {
        config: OllamaConfig;
        fetchImpl: OllamaFetch | null;
        playerCount: number;
        room: string;
        seed: number;
        seen: Set<string>;
        now: () => number;
        started: number;
        cap: number;
        log?: (line: string) => void;
    },
): Promise<PlanResult> {
    const accepted: Prompt[] = [];
    const reasons: Record<string, number> = {};
    let asked = 0;
    let dropped = 0;
    let offline = false;
    let capped = false;

    // One retry for a short or malformed reply; never a bank refill.
    for (let attempt = 0; attempt < 2; attempt++) {
        if (accepted.length >= plan.required) break;
        if (context.now() - context.started >= context.cap) {
            capped = true;
            break;
        }
        const need = plan.required - accepted.length;
        const want = Math.min(plan.count - accepted.length, Math.max(need, need + 1));
        if (want <= 0) break;
        asked += want;
        const result = await callOllama(
            context.config,
            {
                messages: [
                    { role: "system", content: systemPrompt() },
                    { role: "user", content: userPromptFor(plan, want) },
                ],
                temperature: 1.0,
                maxTokens: Math.min(4_096, 300 + want * 80),
            },
            context.fetchImpl,
        );
        if (!result.ok || !result.text) {
            if (result.reason === "network" || result.reason === "disabled") offline = true;
            reasons.unavailable = (reasons.unavailable ?? 0) + 1;
            dropped += want;
            if (result.reason === "network" || result.reason === "disabled" || result.reason === "timeout") break;
            continue;
        }
        const parsed = parseGenerated(result.text, plan);
        let acceptedHere = 0;
        for (let i = 0; i < parsed.length; i++) {
            const item = parsed[i]!;
            // A production request sends no real names, so do not turn a
            // player's name back into a slot here: a question that happens to
            // contain a word like "Will" or "Grace" is not naming that player.
            const candidate = item.text.trim();
            if (!candidate) { dropped += 1; continue; }
            if (candidate.length > MAX_PROMPT_CHARS) {
                reasons["too-long"] = (reasons["too-long"] ?? 0) + 1;
                dropped += 1;
                continue;
            }
            if (isRefusal(candidate) || isMetaCommentary(candidate)) {
                reasons.refusal = (reasons.refusal ?? 0) + 1;
                dropped += 1;
                continue;
            }
            if ((needsHeat(plan) && !isSpicy(candidate))
                || (plan.key === "dare" && !isFilthyDare(candidate))) {
                reasons.tame = (reasons.tame ?? 0) + 1;
                dropped += 1;
                continue;
            }
            if (!slotCheck(candidate, plan, context.playerCount)) {
                reasons["not-in-room"] = (reasons["not-in-room"] ?? 0) + 1;
                dropped += 1;
                continue;
            }
            const norm = normalizeForMatch(candidate);
            if (context.seen.has(norm)) {
                reasons.repeat = (reasons.repeat ?? 0) + 1;
                dropped += 1;
                continue;
            }
            context.seen.add(norm);
            const metric = item.metric ?? inferMetric(candidate);
            const kind = plan.fixedKind ?? item.kind;
            const trait = kind === "rating" ? inferTrait(metric, candidate) : undefined;
            accepted.push({
                id: `${context.room}-${plan.key}-${accepted.length + 1}-ollama`,
                source: "ollama",
                band: plan.band,
                role: plan.role,
                kind,
                text: candidate,
                measures: [
                    ...(trait ? [`trait:${trait}`] : []),
                    ...(metric ? [`metric:${metric}`] : []),
                    `flavour:${plan.key}`,
                ],
                coding: codingFor(metric, candidate),
                asksTarget: plan.role === "observer_subject"
                    || plan.role === "observer_pair"
                    || plan.role === "dare"
                    || plan.role === "group"
                    || (plan.role === "subject" && kind === "pick"),
            });
            acceptedHere += 1;
            if (accepted.length >= plan.required) break;
        }
        if (acceptedHere === 0) reasons.empty = (reasons.empty ?? 0) + 1;
        if (context.now() - context.started >= context.cap) {
            capped = true;
            break;
        }
    }

    return {
        prompts: accepted,
        asked,
        dropped,
        reasons,
        missing: Math.max(0, plan.required - accepted.length),
        offline,
        capped,
    };
}

function chainUserPrompt(want: number): string {
    return [
        "PLAN: look-chain",
        "ROLE: look-chain",
        "A look chain is a three-beat live moment. The actor looks at someone they choose; the room guesses who; the actor says why.",
        "Write original, adult flavours: desire, cheating, secret crushes, exes, bodies, jealousy, a secret. No safe friendship prompts, no repeats.",
        "For each line return one JSON object: {\"announce\":\"Everybody look at {A}.\",\"act\":\"Look at ...\",\"guess\":\"Who is {A} ...?\",\"why\":\"Why ...?\"}",
        "act is read by the actor (start with \"Look at\"). guess is read by everyone else and MUST contain {A}. why is read by the actor and must be a short question.",
        "Keep the three lines about the same flavour. No real names. No two flavours the same.",
        `Write exactly ${want} JSON lines.`,
    ].join("\n");
}

/** Only the {A} placeholder may survive into a chain line. */
function chainBraces(text: string): string[] {
    return text.match(/\{[^}]*\}/g) ?? [];
}

function validChainCopy(act: string, announce: string, guess: string, why: string): boolean {
    if (!announce.includes("{A}") || !guess.includes("{A}")) return false;
    if (chainBraces(announce).some((slot) => slot !== "{A}")) return false;
    if (chainBraces(guess).some((slot) => slot !== "{A}")) return false;
    // A half-written brace is just as raw as a {P2}.
    if (/[{}]/.test(announce.replace(/\{A\}/g, "")) || /[{}]/.test(guess.replace(/\{A\}/g, ""))) return false;
    if (/[{}]/.test(act) || /[{}]/.test(why)) return false;
    if (!/^\s*look at\b/i.test(act)) return false;
    if (!isSpicy(act)) return false;
    return true;
}

async function runChains(
    want: number,
    context: {
        config: OllamaConfig;
        fetchImpl: OllamaFetch | null;
        now: () => number;
        started: number;
        cap: number;
    },
): Promise<{ chains: NightChain[]; batch: GenerationBatch; offline: boolean; capped: boolean }> {
    const chains: NightChain[] = [];
    const reasons: Record<string, number> = {};
    let asked = 0;
    let dropped = 0;
    let offline = false;
    let capped = false;
    const chainSeen = new Set<string>();
    const actSeen = new Set<string>();
    const guessSeen = new Set<string>();
    const whySeen = new Set<string>();
    for (let attempt = 0; attempt < 2 && chains.length < want; attempt++) {
        if (context.now() - context.started >= context.cap) { capped = true; break; }
        const need = want - chains.length;
        asked += need + 1;
        const result = await callOllama(context.config, {
            messages: [
                { role: "system", content: systemPrompt() },
                { role: "user", content: chainUserPrompt(need + 1) },
            ],
            temperature: 1.0,
            maxTokens: 1_800,
        }, context.fetchImpl);
        if (!result.ok || !result.text) {
            if (result.reason === "network" || result.reason === "disabled") offline = true;
            reasons.unavailable = (reasons.unavailable ?? 0) + 1;
            dropped += need + 1;
            if (result.reason === "network" || result.reason === "disabled" || result.reason === "timeout") break;
            continue;
        }
        const text = result.text.replace(/^```(?:json|jsonl)?/gim, "").replace(/```/g, "").trim();
        const objects: unknown[] = [];
        if (text.startsWith("[")) {
            try {
                const array = JSON.parse(text) as unknown;
                if (Array.isArray(array)) objects.push(...array);
            } catch { /* lines below */ }
        }
        if (objects.length === 0) {
            for (const line of text.split(/\r?\n/)) {
                const cleaned = cleanLine(line);
                if (!cleaned.startsWith("{")) continue;
                try { objects.push(JSON.parse(cleaned) as unknown); } catch { /* skip */ }
            }
        }
        for (const item of objects) {
            if (!item || typeof item !== "object") { dropped += 1; continue; }
            const record = item as Record<string, unknown>;
            const act = typeof record.act === "string" ? cleanLine(record.act) : "";
            const guess = typeof record.guess === "string" ? cleanLine(record.guess) : "";
            const why = typeof record.why === "string" ? cleanLine(record.why) : "";
            const announce = typeof record.announce === "string" ? cleanLine(record.announce) : "";
            if (!act || !guess || !why || !announce) {
                reasons["missing-copy"] = (reasons["missing-copy"] ?? 0) + 1;
                dropped += 1;
                continue;
            }
            if ([act, guess, why, announce].some((line) => line.length > MAX_PROMPT_CHARS || isRefusal(line) || isMetaCommentary(line))) {
                reasons.refusal = (reasons.refusal ?? 0) + 1;
                dropped += 1;
                continue;
            }
            if (!validChainCopy(act, announce, guess, why)) {
                reasons["bad-copy"] = (reasons["bad-copy"] ?? 0) + 1;
                dropped += 1;
                continue;
            }
            const actNorm = normalizeForMatch(act);
            const guessNorm = normalizeForMatch(guess);
            const whyNorm = normalizeForMatch(why);
            const signature = normalizeForMatch([announce, act, guess, why].join(" "));
            if (chainSeen.has(signature) || actSeen.has(actNorm) || guessSeen.has(guessNorm) || whySeen.has(whyNorm)) {
                reasons.repeat = (reasons.repeat ?? 0) + 1;
                dropped += 1;
                continue;
            }
            chainSeen.add(signature);
            actSeen.add(actNorm);
            guessSeen.add(guessNorm);
            whySeen.add(whyNorm);
            chains.push({ announce, act, guess, why, source: "ollama" });
            if (chains.length >= want) break;
        }
    }
    return {
        chains,
        batch: { label: "look-chain", asked, accepted: chains.length, dropped, reasons },
        offline,
        capped,
    };
}

/**
 * Run the whole night's generation. No bank prompts are involved.
 *
 * The report always carries whatever the model produced. If `error` is set,
 * the caller MUST NOT start the night: there is deliberately no fallback.
 */
export async function generateNight(input: GenerateBatchInput): Promise<GenerateBatchReport> {
    const config = { ...ollamaConfig(), ...(input.config ?? {}) };
    const now = input.now ?? (() => Date.now());
    const started = now();
    const cap = input.safetyCapMs ?? GEN_SAFETY_CAP_MS;
    const room = input.room && input.room.length > 0 ? input.room : "night";
    const playerCount = Math.max(4, Math.min(11, input.playerCount));
    const plans = planNight(playerCount);
    const seen = new Set<string>();
    const prompts: Prompt[] = [];
    const batches: GenerationBatch[] = [];
    const missing: string[] = [];
    let accepted = 0;
    let dropped = 0;
    let offline = false;
    let capped = false;

    // Three calls at a time. A local model still has to serialise its own
    // work, but this removes most of the round-trip wait and keeps the whole
    // night under the safety cap on a slower laptop.
    const CONCURRENCY = 3;
    let planIndex = 0;
    while (planIndex < plans.length) {
        if (now() - started >= cap) { capped = true; break; }
        const wave = plans.slice(planIndex, planIndex + CONCURRENCY);
        planIndex += wave.length;
        const results = await Promise.all(wave.map((plan) => runPlan(plan, {
            config,
            fetchImpl: input.fetchImpl ?? null,
            playerCount,
            room,
            seed: input.seed,
            seen,
            now,
            started,
            cap,
            ...(input.log ? { log: input.log } : {}),
        })));
        for (let i = 0; i < wave.length; i++) {
            const plan = wave[i]!;
            const result = results[i]!;
            prompts.push(...result.prompts);
            accepted += result.prompts.length;
            dropped += result.dropped;
            offline ||= result.offline;
            capped ||= result.capped;
            if (result.missing > 0) missing.push(`${plan.key} (${result.missing} short)`);
            batches.push({
                label: plan.key,
                asked: result.asked,
                accepted: result.prompts.length,
                dropped: result.dropped,
                reasons: result.reasons,
            });
            input.log?.(`Ollama: ${plan.key} asked ${result.asked}, accepted ${result.prompts.length}, dropped ${result.dropped} (${formatReasonSummary(result.reasons)})`);
        }
        input.onProgress?.(accepted);
        if (offline || capped) break;
    }
    if (offline || capped) {
        for (const plan of plans.slice(planIndex)) missing.push(plan.key);
    }

    let chains: NightChain[] = [];
    if (!offline && !capped && now() - started < cap) {
        const chainRun = await runChains(chainsFor(playerCount), {
            config,
            fetchImpl: input.fetchImpl ?? null,
            now,
            started,
            cap,
        });
        chains = chainRun.chains;
        batches.push(chainRun.batch);
        accepted += chainRun.chains.length;
        dropped += chainRun.batch.dropped;
        offline ||= chainRun.offline;
        capped ||= chainRun.capped;
        const chainShort = chainsFor(playerCount) - chains.length;
        if (chainShort > 0) missing.push(`look-chain (${chainShort} short)`);
        input.log?.(`Ollama: look-chain asked ${chainRun.batch.asked}, accepted ${chainRun.chains.length}, dropped ${chainRun.batch.dropped} (${formatReasonSummary(chainRun.batch.reasons)})`);
        input.onProgress?.(accepted);
    } else if (!offline) {
        missing.push("look-chain");
    }

    if (capped) missing.push("safety cap reached");
    if (offline) missing.push("Ollama unreachable");

    const bestCouple = prompts.find((p) => p.role === "group" && p.kind === "pair_pick");
    const watchers = prompts.filter((p) => p.role === "group" && p.measures.includes("flavour:dare-watch"));
    const nightPrompts = prompts.filter((p) => !(
        (p.role === "group" && p.kind === "pair_pick") || p.measures.includes("flavour:dare-watch")
    ));

    let error: string | undefined;
    if (missing.length > 0) {
        const base = offline
            ? `Ollama is unreachable at ${config.baseUrl} (model ${config.model}).`
            : capped
                ? "Ollama took too long to write tonight's questions."
                : "Ollama did not write enough usable questions.";
        error = `${base} Missing: ${missing.join(", ")}. Check GEN_BASE, GEN_MODEL and that Ollama is running, then press Start again.`;
    }

    const totalRequired = plans.reduce((sum, plan) => sum + plan.required, 0) + chainsFor(playerCount) * 3;
    return {
        prompts: nightPrompts,
        chains,
        ...(bestCouple ? { bestCouple } : {}),
        watchers,
        batches,
        accepted,
        dropped,
        capped,
        offline,
        target: Math.max(GEN_TARGET_PROMPTS, totalRequired),
        ...(error ? { error } : {}),
        missing,
    };
}

function formatReasonSummary(reasons: Record<string, number>): string {
    const entries = Object.entries(reasons).filter(([, n]) => n > 0);
    return entries.length === 0 ? "none" : entries.map(([reason, n]) => `${reason}:${n}`).join(", ");
}

export { GEN_SAFETY_CAP_MS, GEN_TARGET_PROMPTS, OLLAMA_DEFAULT_MODEL };
export type { MetricKey };

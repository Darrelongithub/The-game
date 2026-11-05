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
    restoreNames,
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

type SlotRule = "none" | "any" | "p1" | "p1p2";

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
    const solo = playerCount % 2 === 0 ? 1 : 0;
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
            slotRule: "none",
            brief: "The phone reading this belongs to the subject. Write to \"you\". They may choose, rate or talk about other people in the room. Never name the subject. Use {P1}, {P2} ... only for other people.",
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
            brief: "An observer pair reads this about {P1}, another player in the room. The question must be about {P1}. Use {P1} literally; {P2} and up may be other people. Never write a real name.",
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
            brief: "An observer pair reads this about two other people, {P1} and {P2}. It must include both slots. Ask for a short opinion or prediction, not a rating.",
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
            slotRule: "none",
            brief: "One person reads this alone. Ask a spicy, personal question to \"you\". No name slots are needed; do not name anyone.",
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
            brief: "The whole room votes on a hypothetical couple, {P1} and {P2}. Ask whether they would make a good couple (or a gay couple, if the room's humour runs that way). Include both slots.",
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
            slotRule: "none",
            brief: "The whole room picks the best couple from a list of pairs. Write one question. Do NOT use any {P1} slots; the list of pairs is supplied by the app.",
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
            brief: "A single named player is dared. Start the line with {P1}, then give a spicy, funny dare they can do in the room or a confession they must make. One line. Filthy is fine.",
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
            brief: "The rest of the room reads this about {P1} and {P2}, who were just given a dare. Ask whether they think the two will do it, and if not, why. Include both slots.",
        },
    ];
    return plans;
}

function systemPrompt(): string {
    return [
        "You are the question writer for an adults-only party game played by friends who all know each other.",
        "Every question is original. Never mention the bank, a template, an AI, a policy, or that you are a model.",
        "Be blunt, funny, nosy and a little filthy. The players are adults and consented to the game.",
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
        plan.slotRule === "p1p2"
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
    const kind = isRoundKind(rawKind) && plan.kinds.includes(rawKind)
        ? rawKind
        : plan.fixedKind ?? inferKind(text, plan);
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

function codingFor(metric: MetricKey | undefined, text: string): PromptCoding {
    if (metric === METRIC.coupleFit || /couple|kiss|date/i.test(text)) return "couple";
    if (metric === METRIC.trust || /trust/i.test(text)) return "trust";
    if (metric === METRIC.wouldCheat || metric === METRIC.betrayal) return "friction";
    if (/friend/i.test(text)) return "friendship";
    if (/rival|enemy/i.test(text)) return "rivalry";
    if (/famous|popular|status/i.test(text)) return "status";
    return "tease";
}

function slotCheck(text: string, plan: PromptPlan, playerCount: number): boolean {
    const indexes = placeholderIndexes(text);
    // placeholderIndexes() hides out-of-range slots; inspect the raw text so a
    // generated {P99} can never reach a phone as a literal.
    for (const match of text.matchAll(/\{P(\d+)\}/g)) {
        const n = Number(match[1]);
        if (!Number.isInteger(n) || n < 1 || n > playerCount) return false;
    }
    // The best-couple question is followed by a list of pairs; a raw slot in
    // the question itself would leak the placeholder on every phone.
    if (plan.key === "best-couple" && indexes.length > 0) return false;
    if (plan.slotRule === "none" || plan.slotRule === "any") {
        // A subject/solo question has to be about the person answering or the
        // room. A generic "favourite colour" line is not a party question.
        if ((plan.role === "subject" || plan.role === "solo") && indexes.length === 0) {
            return /\b(?:you|your|yours|yourself|this room|everyone here|who here)\b/i.test(text);
        }
        return true;
    }
    if (plan.slotRule === "p1") return indexes.includes(1);
    return indexes.includes(1) && indexes.includes(2);
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
        aliases: readonly string[];
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
            const candidate = restoreNames(item.text, context.aliases).trim();
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
            accepted.push({
                id: `${context.room}-${plan.key}-${accepted.length + 1}-ollama`,
                source: "ollama",
                band: plan.band,
                role: plan.role,
                kind: plan.fixedKind ?? item.kind,
                text: candidate,
                measures: [...(metric ? [`metric:${metric}`] : []), `flavour:${plan.key}`],
                coding: codingFor(metric, candidate),
                asksTarget: plan.role !== "subject" || (plan.fixedKind ?? item.kind) === "pick",
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
        "Write original flavours. For each line return one JSON object: {\"announce\":\"Everybody look at {A}.\",\"act\":\"Look at ...\",\"guess\":\"Who is {A} ...?\",\"why\":\"Why ...?\"}",
        "act is read by the actor (start with \"Look at\"). guess is read by everyone else and MUST contain {A}. why is read by the actor and must be a short question.",
        "Keep the three lines about the same flavour. No real names. No two flavours the same.",
        `Write exactly ${want} JSON lines.`,
    ].join("\n");
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
            const announce = typeof record.announce === "string" && record.announce.includes("{A}")
                ? cleanLine(record.announce)
                : "Everybody look at {A}.";
            if (!act || !guess || !why || !guess.includes("{A}")) { dropped += 1; continue; }
            if ([act, guess, why, announce].some((line) => line.length > MAX_PROMPT_CHARS || isRefusal(line))) {
                dropped += 1;
                continue;
            }
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
            aliases: input.aliases ?? [],
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

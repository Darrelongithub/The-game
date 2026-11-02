// packages/prompts/src/bank/index.ts
// THE PROMPT BANK — the code-first primary implementation of every question.
//
// v3.2 shape: the bank is no longer organised in PHASES (the night has no
// phase names) but in HEAT BANDS, and every prompt carries the ROLE it plays
// inside a case:
//
//   subject          asked to the case subject — a real question of their own
//   observer_subject asked to an observer pair — about the case subject
//   observer_pair    asked to an observer pair — about ANOTHER pair in the room
//   group            asked to everyone — results are counts only
//   solo             the odd leftover observer gets a spicy prompt of their own
//   dare             aimed at a named player
//
// LOADER ORDER: the spicy tier and the unhinged tier come FIRST. The night
// starts hot; the tame prompts are the tail, not the opening.
//
// ZERO network, ZERO provider calls: this file alone makes a full night
// playable offline.
import { readFileSync } from "node:fs";
import {
  MAX_PLAYERS,
  type Band,
  type MetricKey,
  type Prompt,
  type PromptCoding,
  type PromptRole,
  type RoundKind,
} from "../../../shared/src/contracts.ts";

/** A bank row as authored in JSON — everything except `source`. */
export type BankEntry = Omit<Prompt, "source">;

/** The four heat bands. Warmup/spicy/deep are question bands; dare is its own. */
export const BANK_BANDS: readonly Band[] = ["warmup", "spicy", "deep", "dare"] as const;

/**
 * Generation order for the local model: spicy FIRST, so that if generation
 * times out the hottest prompts already exist.
 */
export const BAND_ORDER: readonly Band[] = ["spicy", "warmup", "deep", "dare"];

/** Round kinds that make sense per band. */
export const BAND_KINDS: Record<Band, readonly RoundKind[]> = {
  warmup: ["pick", "text", "longtext", "rating"],
  spicy: ["pick", "text", "longtext", "rating", "pair_vote", "pair_pick"],
  deep: ["pick", "text", "longtext", "rating", "pair_vote", "pair_pick"],
  dare: ["dare"],
};

const BANK_FILES: Record<Band, string> = {
  warmup: "warmup.json",
  spicy: "spicy.json",
  deep: "deep.json",
  dare: "dare.json",
};

/** The unhinged tier — loaded BEFORE the seed prompts. */
const UNHINGED_FILE = "unhinged.json";

function readJson<T>(file: string): T {
  // Server-side package: read relative to this module so it works from any cwd
  // and under tsx / node --test / the game server alike.
  const url = new URL(file, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as T;
}

function readBankFile(file: string): BankEntry[] {
  const rows = readJson<BankEntry[]>(file);
  if (!Array.isArray(rows)) throw new Error(`bank file ${file} is not an array`);
  for (const row of rows) {
    if (!row.id || !row.text) throw new Error(`bank file ${file} has a row without id/text`);
    if (!BANK_BANDS.includes(row.band)) throw new Error(`bank row ${row.id} has unknown band ${row.band}`);
    if (!row.role) throw new Error(`bank row ${row.id} has no role`);
    if (!row.kind) throw new Error(`bank row ${row.id} has no kind`);
  }
  return rows;
}

/** Raw rows, keyed by file — handy for tests and for the host's prompt preview. */
export const RAW_BANK: { bands: Record<Band, BankEntry[]>; unhinged: BankEntry[] } = {
  bands: {
    warmup: readBankFile(BANK_FILES.warmup),
    spicy: readBankFile(BANK_FILES.spicy),
    deep: readBankFile(BANK_FILES.deep),
    dare: readBankFile(BANK_FILES.dare),
  },
  unhinged: readBankFile(UNHINGED_FILE),
};

/**
 * Whole bank. ORDER MATTERS:
 *   1. the unhinged tier — the hottest prompts in the game, loaded FIRST
 *   2. the spicy band seeds
 *   3. warmup
 *   4. deep
 *   5. dare
 * The night is shuffled from this pool with a nightly seed, so the loader
 * order decides the TONE of a night (hot first) rather than the exact
 * sequence (which is shuffled).
 */
export function loadBank(): Prompt[] {
  const out: Prompt[] = [];
  const push = (rows: BankEntry[]) => {
    for (const row of rows) out.push({ ...row, source: "bank" });
  };
  push(RAW_BANK.unhinged);
  push(RAW_BANK.bands.spicy);
  push(RAW_BANK.bands.warmup);
  push(RAW_BANK.bands.deep);
  push(RAW_BANK.bands.dare);
  return out;
}

/** The bank, for this process, in order. */
export const BANK: readonly Prompt[] = loadBank();

export function bankForBand(band: Band): Prompt[] {
  return loadBank().filter((p) => p.band === band);
}

export function bankCounts(): Record<Band, number> {
  const counts: Record<Band, number> = { warmup: 0, spicy: 0, deep: 0, dare: 0 };
  for (const p of loadBank()) counts[p.band] += 1;
  return counts;
}

/** Total prompts available tonight. */
export function bankTotal(): number {
  return loadBank().length;
}

// ---------- placeholders ----------
const PLACEHOLDER_RE = /\{P(\d{1,2})\}/g;
/** Any `{…}` token — used by the filter to reject invented placeholders. */
export const ANY_BRACE_RE = /\{[^}]*\}/g;

/** All `{Pn}` indices used by a text (0 for none). Invalid tokens report NaN-free 0. */
export function placeholderIndexes(text: string): number[] {
  const found: number[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_PLAYERS) found.push(n);
  }
  return [...new Set(found)].sort((a, b) => a - b);
}

/** Highest `{Pn}` index in a text (0 when it has none). */
export function maxPlaceholderIndex(text: string): number {
  const idx = placeholderIndexes(text);
  return idx.length === 0 ? 0 : idx[idx.length - 1]!;
}

// ---------- metrics ----------
/** The metric a prompt measures, if any ("metric:crush" → "crush"). */
export function metricOf(prompt: Pick<Prompt, "measures">): MetricKey | undefined {
  for (const m of prompt.measures) {
    if (m.startsWith("metric:")) return m.slice("metric:".length) as MetricKey;
  }
  return undefined;
}

/**
 * The prompt's TYPE — the thing that must never repeat back to back.
 *
 * Two prompts are "the same type" when they ask for the same KIND of answer
 * about the same THING (kind + metric). The night never plays two of the same
 * type in a row, so the room never hears two "pick the hottest person here"
 * questions in a row.
 */
export function promptTypeKey(prompt: Pick<Prompt, "kind" | "measures" | "coding">): string {
  return `${prompt.kind}:${metricOf(prompt) ?? prompt.coding}`;
}

// ---------- selection ----------
export interface SelectOptions {
  /** Players in the room — prompts needing a higher {Pn} are skipped. */
  playerCount?: number;
  /** Ids already used tonight (never repeat a prompt). */
  excludeIds?: readonly string[];
  /** Only prompts with this role. */
  role?: PromptRole;
  /** Only prompts of these roles. */
  roles?: readonly PromptRole[];
  /** Only these round kinds. */
  kinds?: readonly RoundKind[];
  /** Only these bands. */
  bands?: readonly Band[];
  /** Only these codings. */
  coding?: readonly PromptCoding[];
  /** Only prompts carrying this metric. */
  metric?: MetricKey;
  /** Seeded shuffle (nightly). Same seed → same selection. */
  seed?: number;
}

/** mulberry32 — small, fast, seedable. Same seed → same night. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/**
 * Deterministic, repeat-free slice of the bank.
 *
 * The pool is shuffled with the nightly seed FIRST, so the selection varies
 * night to night but is reproducible for a given seed. Selection then prefers
 * a SPREAD of kinds and metrics so two same-type prompts never land back to
 * back, and never returns the same template twice.
 */
export function selectFromBank(n: number, opts: SelectOptions = {}): Prompt[] {
  const exclude = new Set(opts.excludeIds ?? []);
  const playerCount = Math.max(1, Math.min(MAX_PLAYERS, opts.playerCount ?? MAX_PLAYERS));
  const kinds = opts.kinds ? new Set(opts.kinds) : null;
  const roles = opts.roles ? new Set(opts.roles) : opts.role ? new Set([opts.role]) : null;
  const bands = opts.bands ? new Set(opts.bands) : null;
  const codings = opts.coding ? new Set(opts.coding) : null;
  const pool = loadBank().filter((p) => {
    if (exclude.has(p.id)) return false;
    if (kinds && !kinds.has(p.kind)) return false;
    if (roles && !roles.has(p.role)) return false;
    if (bands && !bands.has(p.band)) return false;
    if (codings && !codings.has(p.coding)) return false;
    if (opts.metric && metricOf(p) !== opts.metric) return false;
    if (maxPlaceholderIndex(p.text) > playerCount) return false;
    return true;
  });
  if (pool.length === 0) return [];
  const shuffled = seededShuffle(pool, opts.seed ?? 0);
  if (n <= 0) return [];

  const picked: Prompt[] = [];
  const taken = new Set<string>();
  const push = (p: Prompt): void => {
    picked.push(p);
    taken.add(p.id);
  };
  // Two prompts are "the same kind of thing" when they ask the same KIND for
  // the same METRIC. That is the pairing that reads as a repeat, even when the
  // codings differ ("who would you sleep with" twice in a row is one joke).
  const adjacencyKey = (p: Prompt): string => `${p.kind}|${metricOf(p) ?? "none"}`;
  const lastKey = (): string => (picked.length ? adjacencyKey(picked[picked.length - 1]!) : "");
  const deferred: Prompt[] = [];

  const fill = (accept: (p: Prompt) => boolean): void => {
    for (const p of shuffled) {
      if (picked.length >= n) return;
      if (taken.has(p.id)) continue;
      if (!accept(p)) continue;
      if (adjacencyKey(p) === lastKey()) {
        deferred.push(p);
        continue;
      }
      push(p);
    }
  };

  // Pass 1: one of each type (kind + metric + coding) — kills same-type
  // back-to-back before anything else is considered.
  const seenTypes = new Set<string>();
  fill((p) => {
    const key = promptTypeKey(p);
    if (seenTypes.has(key)) return false;
    seenTypes.add(key);
    return true;
  });

  // Pass 2: fill the rest, still never landing the same kind twice in a row.
  fill(() => true);

  // Pass 3: a thin pool still fills the slot (adjacency allowed, never a
  // repeated template).
  for (const p of deferred) {
    if (picked.length >= n) break;
    if (taken.has(p.id)) continue;
    push(p);
  }
  return picked.slice(0, n);
}

/**
 * The whole night's worth of prompts for one band, shuffled with the nightly
 * seed. The server asks for bands in BAND_ORDER (spicy first).
 */
export function selectBand(
  band: Band,
  n: number,
  opts: SelectOptions = {},
): Prompt[] {
  return selectFromBank(n, { ...opts, bands: [band] });
}

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
  SPICY_TIER,
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

/** un-* ids — the unhinged tier. Never sent to any provider. */
export const UNHINGED_IDS: readonly string[] = RAW_BANK.unhinged.map((e) => e.id);

/**
 * SPICY_TIER resolution: contracts.ts is the source of truth (default true),
 * but the host may switch the tier off for a tamer night via `SPICY_TIER=false`
 * in `.env` — no contract edit needed.
 */
export function spicyTierEnabled(env: Record<string, string | undefined> = readEnv()): boolean {
  const raw = env.SPICY_TIER;
  if (raw === undefined || raw.trim() === "") return SPICY_TIER;
  return !["false", "0", "off", "no", "n"].includes(raw.trim().toLowerCase());
}

function readEnv(): Record<string, string | undefined> {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

export interface BankOptions {
  /** Include the unhinged tier (default: SPICY_TIER / env override). */
  spicy?: boolean;
}

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
export function loadBank(opts: BankOptions = {}): Prompt[] {
  const spicy = opts.spicy ?? spicyTierEnabled();
  const out: Prompt[] = [];
  const push = (rows: BankEntry[]) => {
    for (const row of rows) out.push({ ...row, source: "bank" });
  };
  if (spicy) push(RAW_BANK.unhinged);
  push(RAW_BANK.bands.spicy);
  push(RAW_BANK.bands.warmup);
  push(RAW_BANK.bands.deep);
  push(RAW_BANK.bands.dare);
  return out;
}

/** The default bank for this process (SPICY_TIER / env resolved once). */
export const BANK: readonly Prompt[] = loadBank();

export function bankForBand(band: Band, opts: BankOptions = {}): Prompt[] {
  return loadBank(opts).filter((p) => p.band === band);
}

export function bankCounts(opts: BankOptions = {}): Record<Band, number> {
  const counts: Record<Band, number> = { warmup: 0, spicy: 0, deep: 0, dare: 0 };
  for (const p of loadBank(opts)) counts[p.band] += 1;
  return counts;
}

/** Total prompts available tonight. */
export function bankTotal(opts: BankOptions = {}): number {
  return loadBank(opts).length;
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
export interface SelectOptions extends BankOptions {
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
  const pool = loadBank(opts).filter((p) => {
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

  // Pass 1: one of each type (kind + metric) — kills same-type back-to-back.
  const seenTypes = new Set<string>();
  for (const p of shuffled) {
    if (picked.length >= n) break;
    const key = promptTypeKey(p);
    if (seenTypes.has(key)) continue;
    seenTypes.add(key);
    push(p);
  }

  // Pass 2: fill the rest, still never repeating the previous type while the
  // pool allows it.
  let lastType = picked.length ? promptTypeKey(picked[picked.length - 1]!) : "";
  const deferred: Prompt[] = [];
  for (const p of shuffled) {
    if (picked.length >= n) break;
    if (taken.has(p.id)) continue;
    const key = promptTypeKey(p);
    if (key === lastType) { deferred.push(p); continue; }
    push(p);
    lastType = key;
  }
  // Pass 3: a thin pool still fills the slot (repeats allowed).
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

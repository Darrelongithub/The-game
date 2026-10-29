// packages/prompts/src/bank/index.ts
// FALLBACK BANK — the code-first primary implementation of every prompt.
//
// Loads one JSON file per phase (spec §6: "≥15 prompts per phase in
// packages/prompts/src/bank/") plus the unhinged tier u1–u27, which is only
// included when SPICY_TIER is on. ZERO network, ZERO provider calls: this file
// alone makes a full night playable offline.
//
// Every entry carries `id, phase, kind, text, measures, coding, asksTarget`
// (the Prompt contract minus `source`, which the loader stamps as "bank").
import { readFileSync } from "node:fs";
import {
  MAX_PLAYERS,
  SPICY_TIER,
  type Prompt,
  type PromptCoding,
  type RoundKind,
} from "../../../shared/src/contracts.ts";

export type PromptPhase = Prompt["phase"];

/** A bank row as authored in JSON — everything except `source`. */
export type BankEntry = Omit<Prompt, "source">;

export const BANK_PHASES: readonly PromptPhase[] = ["warmup", "spicy", "deep", "dare"] as const;

/** Round kinds that make sense in each phase (spec §3 + the bank's own mix). */
export const PHASE_KINDS: Record<PromptPhase, readonly RoundKind[]> = {
  warmup: ["pick", "text", "shout", "rating", "ios", "minigame"],
  spicy: ["pick", "text", "shout", "rating", "ios", "minigame"],
  deep: ["pick", "text", "shout", "rating", "ios", "minigame"],
  dare: ["dare", "pair_dare", "debrief"],
};

const BANK_FILES: Record<PromptPhase, string> = {
  warmup: "warmup.json",
  spicy: "spicy.json",
  deep: "deep.json",
  dare: "dare.json",
};

const UNHINGED_FILE = "unhinged.json";

function readJson<T>(file: string): T {
  // Server-side package: read relative to this module so it works from any cwd
  // and under tsx / node --test / the game server alike (no import attributes,
  // no bundler assumptions).
  const url = new URL(file, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as T;
}

function readBankFile(file: string): BankEntry[] {
  const rows = readJson<BankEntry[]>(file);
  if (!Array.isArray(rows)) throw new Error(`bank file ${file} is not an array`);
  return rows;
}

/** Raw rows, keyed by file — handy for tests and for the host's prompt preview. */
export const RAW_BANK: { phases: Record<PromptPhase, BankEntry[]>; unhinged: BankEntry[] } = {
  phases: {
    warmup: readBankFile(BANK_FILES.warmup),
    spicy: readBankFile(BANK_FILES.spicy),
    deep: readBankFile(BANK_FILES.deep),
    dare: readBankFile(BANK_FILES.dare),
  },
  unhinged: readBankFile(UNHINGED_FILE),
};

/** u1–u27 — spicy-tier only (spec §6). Never sent to any provider. */
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
  // `process` is always present server-side; guard anyway so the bank can be
  // imported by tooling without node types.
  return typeof process !== "undefined" && process.env ? process.env : {};
}

export interface BankOptions {
  /** Include the unhinged tier (default: SPICY_TIER / env override). */
  spicy?: boolean;
}

/**
 * Whole bank, deterministic order: warmup → spicy → deep → dare, authored
 * order inside each phase, unhinged tier appended after its phase's seeds.
 */
export function loadBank(opts: BankOptions = {}): Prompt[] {
  const spicy = opts.spicy ?? spicyTierEnabled();
  const out: Prompt[] = [];
  for (const phase of BANK_PHASES) {
    for (const row of RAW_BANK.phases[phase]) out.push({ ...row, source: "bank" });
    if (spicy) {
      for (const row of RAW_BANK.unhinged) {
        if (row.phase === phase) out.push({ ...row, source: "bank" });
      }
    }
  }
  return out;
}

/** The default bank for this process (SPICY_TIER / env resolved once). */
export const BANK: readonly Prompt[] = loadBank();

export function bankForPhase(phase: PromptPhase, opts: BankOptions = {}): Prompt[] {
  return loadBank(opts).filter((p) => p.phase === phase);
}

export function bankCounts(opts: BankOptions = {}): Record<PromptPhase, number> {
  const counts: Record<PromptPhase, number> = { warmup: 0, spicy: 0, deep: 0, dare: 0 };
  for (const p of loadBank(opts)) counts[p.phase] += 1;
  return counts;
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

// ---------- selection ----------
export interface SelectOptions extends BankOptions {
  /** Players in the room — prompts needing a higher {Pn} are skipped. */
  playerCount?: number;
  /** Ids already used tonight (never repeat a prompt). */
  excludeIds?: readonly string[];
  /** Optional filter (e.g. only "pick" kinds for a given slot). */
  kinds?: readonly RoundKind[];
  /** Optional coding filter. */
  coding?: readonly PromptCoding[];
}

/** Deterministic, repeat-free slice of the bank for a phase. */
export function selectFromBank(phase: PromptPhase, n: number, opts: SelectOptions = {}): Prompt[] {
  const exclude = new Set(opts.excludeIds ?? []);
  const playerCount = Math.max(1, Math.min(MAX_PLAYERS, opts.playerCount ?? MAX_PLAYERS));
  const kinds = opts.kinds ? new Set(opts.kinds) : null;
  const codings = opts.coding ? new Set(opts.coding) : null;
  const pool = bankForPhase(phase, opts).filter((p) => {
    if (exclude.has(p.id)) return false;
    if (kinds && !kinds.has(p.kind)) return false;
    if (codings && !codings.has(p.coding)) return false;
    if (maxPlaceholderIndex(p.text) > playerCount) return false;
    return true;
  });
  // Prefer a spread of round kinds instead of three picks in a row: take one
  // of each kind in bank order, then fill the remainder in bank order. Fully
  // deterministic (no randomness — spec §0.1).
  const picked: Prompt[] = [];
  const seenKinds = new Set<RoundKind>();
  for (const p of pool) {
    if (picked.length >= n) break;
    if (!seenKinds.has(p.kind)) {
      seenKinds.add(p.kind);
      picked.push(p);
    }
  }
  for (const p of pool) {
    if (picked.length >= n) break;
    if (!picked.includes(p)) picked.push(p);
  }
  return picked.slice(0, Math.max(0, n));
}

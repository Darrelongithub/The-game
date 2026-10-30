// apps/server/src/accounts.ts
// ROUND 4 — ACCOUNTS. No email, ever.
//
// A player is a username (3–16 chars, [a-z0-9_], case-insensitive unique), a
// 4–6 digit PIN and the ONE-TIME recovery code shown when the account is made
// ("store it, there is no email"). The client holds an opaque token; the server
// holds scrypt hashes and hashed token seeds and nothing that identifies a
// human.
//
// Persistence is deliberately separate from rooms: rooms are purged after 48h
// (spec §9), identity is not. DELETE wipes the record and every night link in
// it — identity gone means everything about it is gone.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { AccountInfo, Hypothesis, HypothesisKind, HypothesisStatus } from "../../../packages/shared/src/contracts.ts";

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 16;
/** Allowed input is [A-Za-z0-9_]; it is canonicalised to lowercase. */
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/u;
const PIN_RE = /^\d{4,6}$/u;
/** Crockford-ish alphabet: no 0/O/1/I, so a written-down code reads back. */
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const RECOVERY_GROUPS = 3;
const RECOVERY_GROUP_LEN = 4;
const TOKEN_SEEDS_MAX = 8;

export type AccountResult = { ok: true; token: string; account: AccountInfo } | { ok: false; error: string };
export type AccountCreateResult = { ok: true; token: string; recoveryCode: string; account: AccountInfo } | { ok: false; error: string };

/**
 * A hypothesis frozen for the NEXT night. Subjects are stored as the ACCOUNT
 * ids that owned them last night (`acct:<id>`); the server maps them back onto
 * tonight's pseudonymous player ids. This is the only place cross-night
 * suspicion is kept, and it never reaches a client (see the Hypothesis
 * contract note: INTERNAL).
 */
export interface StoredHypothesis {
  kind: HypothesisKind;
  subjects: string[];          // account-scoped subject keys
  status: HypothesisStatus;
  strength: number;
  evidence: string[];
  openedAt: number;
  lastTestedRound?: string;
}

interface StoredSeed { salt: string; hash: string; createdAt: number; }

interface StoredAccount {
  id: string;
  username: string;            // canonical lowercase — the uniqueness key
  pinSalt: string;
  pinHash: string;
  recoverySalt: string;
  recoveryHash: string;
  createdAt: number;
  nightsPlayed: number;
  /** rooms already counted, so a reconnect or replay never double-counts */
  nights: string[];
  tokenSeeds: StoredSeed[];
  /** unresolved suspicions carried into the next night (internal only) */
  priors: StoredHypothesis[];
}

interface AccountFile { version: 1; accounts: StoredAccount[]; }

export interface AccountStoreOptions {
  file: string;
  now?: () => number;
  /** Test seam only: production cost is the Node default (N=16384). */
  scrypt?: { N: number; r: number; p: number; maxmem?: number };
  /** Failed logins per username before the door closes for `lockMs`. */
  maxFailures?: number;
  lockMs?: number;
}

const canonical = (username: string): string => username.trim().toLowerCase();
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const makeRecoveryCode = (): string => {
  const chars: string[] = [];
  const bytes = randomBytes(RECOVERY_GROUPS * RECOVERY_GROUP_LEN);
  for (let i = 0; i < bytes.length; i++) chars.push(RECOVERY_ALPHABET[bytes[i]! % RECOVERY_ALPHABET.length]!);
  const groups: string[] = [];
  for (let g = 0; g < RECOVERY_GROUPS; g++) groups.push(chars.slice(g * RECOVERY_GROUP_LEN, (g + 1) * RECOVERY_GROUP_LEN).join(""));
  return groups.join("-");
};

/** " abcd-efgh " and "ABCDEFGH" both read as the same code. */
const normalizeRecoveryCode = (code: string): string =>
  code.toUpperCase().replace(/[^A-Z0-9]/gu, "");

export class AccountStore {
  private accounts = new Map<string, StoredAccount>();
  private readonly file: string;
  private readonly now: () => number;
  private readonly scrypt: { N: number; r: number; p: number; maxmem?: number };
  private readonly maxFailures: number;
  private readonly lockMs: number;
  private readonly failures = new Map<string, { count: number; until: number }>();

  constructor(options: AccountStoreOptions) {
    this.file = options.file;
    this.now = options.now ?? Date.now;
    this.scrypt = options.scrypt ?? { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
    this.maxFailures = options.maxFailures ?? 5;
    this.lockMs = options.lockMs ?? 5 * 60_000;
    this.load();
  }

  // ---------- persistence ----------

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<AccountFile>;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.accounts)) return;
      for (const account of parsed.accounts) {
        if (account && typeof account.id === "string" && typeof account.username === "string") {
          this.accounts.set(account.username, {
            ...account,
            nights: Array.isArray(account.nights) ? account.nights : [],
            tokenSeeds: Array.isArray(account.tokenSeeds) ? account.tokenSeeds : [],
            priors: Array.isArray(account.priors) ? account.priors : [],
          });
        }
      }
    } catch {
      // A corrupt identity file must never take the game server down; it just
      // means nobody can log in until the host clears it.
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const payload: AccountFile = { version: 1, accounts: [...this.accounts.values()] };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    renameSync(tmp, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* best effort on odd filesystems */ }
  }

  // ---------- hashing ----------

  private hash(secret: string, salt: string): string {
    return scryptSync(secret, Buffer.from(salt, "hex"), 32, this.scrypt).toString("hex");
  }

  private static matches(expectedHex: string, actualHex: string): boolean {
    const a = Buffer.from(expectedHex, "hex");
    const b = Buffer.from(actualHex, "hex");
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
  }

  private newToken(account: StoredAccount): string {
    const token = randomBytes(32).toString("base64url");
    const salt = randomBytes(16).toString("hex");
    account.tokenSeeds.push({ salt, hash: this.hash(token, salt), createdAt: this.now() });
    if (account.tokenSeeds.length > TOKEN_SEEDS_MAX) account.tokenSeeds.splice(0, account.tokenSeeds.length - TOKEN_SEEDS_MAX);
    return token;
  }

  /** Hashed token seeds only: the raw token exists on the client and nowhere else. */
  private accountForToken(token: string): StoredAccount | undefined {
    if (typeof token !== "string" || token.length < 16) return undefined;
    for (const account of this.accounts.values()) {
      for (const seed of account.tokenSeeds) {
        if (AccountStore.matches(seed.hash, this.hash(token, seed.salt))) return account;
      }
    }
    return undefined;
  }

  // ---------- public API ----------

  private info(account: StoredAccount): AccountInfo {
    return { username: account.username, createdAt: account.createdAt, nightsPlayed: account.nightsPlayed };
  }

  private throttleKey(username: string): string { return canonical(username); }

  private locked(username: string): boolean {
    const entry = this.failures.get(this.throttleKey(username));
    if (!entry) return false;
    if (entry.until <= this.now()) { this.failures.delete(this.throttleKey(username)); return false; }
    return entry.count >= this.maxFailures;
  }

  private failed(username: string): void {
    const key = this.throttleKey(username);
    const entry = this.failures.get(key) ?? { count: 0, until: 0 };
    entry.count += 1;
    entry.until = this.now() + this.lockMs;
    this.failures.set(key, entry);
  }

  create(username: unknown, pin: unknown): AccountCreateResult {
    if (typeof username !== "string" || !USERNAME_RE.test(username.trim())) {
      return { ok: false, error: `Username must be ${USERNAME_MIN}–${USERNAME_MAX} characters: letters, numbers or underscore.` };
    }
    if (typeof pin !== "string" || !PIN_RE.test(pin)) return { ok: false, error: "PIN must be 4–6 digits." };
    const key = canonical(username);
    if (this.accounts.has(key)) return { ok: false, error: "That username is taken." };
    const now = this.now();
    const pinSalt = randomBytes(16).toString("hex");
    const recoverySalt = randomBytes(16).toString("hex");
    const recoveryCode = makeRecoveryCode();
    const account: StoredAccount = {
      id: randomBytes(12).toString("hex"),
      username: key,
      pinSalt,
      pinHash: this.hash(pin, pinSalt),
      recoverySalt,
      recoveryHash: this.hash(normalizeRecoveryCode(recoveryCode), recoverySalt),
      createdAt: now,
      nightsPlayed: 0,
      nights: [],
      tokenSeeds: [],
      priors: [],
    };
    const token = this.newToken(account);
    this.accounts.set(key, account);
    this.save();
    // The only time this code is ever visible. There is no way to mail it.
    return { ok: true, token, recoveryCode, account: this.info(account) };
  }

  login(username: unknown, pin: unknown): AccountResult {
    if (typeof username !== "string" || typeof pin !== "string") return { ok: false, error: "Username and PIN required." };
    const key = canonical(username);
    if (this.locked(key)) return { ok: false, error: "Too many attempts. Try again in a few minutes." };
    const account = this.accounts.get(key);
    if (!account || !AccountStore.matches(account.pinHash, this.hash(pin, account.pinSalt))) {
      this.failed(key);
      return { ok: false, error: "Wrong username or PIN." };
    }
    this.failures.delete(key);
    const token = this.newToken(account);
    this.save();
    return { ok: true, token, account: this.info(account) };
  }

  /** Recovery code (not PIN) → fresh session + a fresh one-time recovery code. */
  recover(username: unknown, recoveryCode: unknown): AccountCreateResult {
    if (typeof username !== "string" || typeof recoveryCode !== "string") return { ok: false, error: "Username and recovery code required." };
    const key = canonical(username);
    if (this.locked(key)) return { ok: false, error: "Too many attempts. Try again in a few minutes." };
    const account = this.accounts.get(key);
    const normalized = normalizeRecoveryCode(recoveryCode);
    if (!account || normalized.length === 0 || !AccountStore.matches(account.recoveryHash, this.hash(normalized, account.recoverySalt))) {
      this.failed(key);
      return { ok: false, error: "That recovery code does not match." };
    }
    this.failures.delete(key);
    // Rotate: a recovery code is single-use.
    const next = makeRecoveryCode();
    account.recoverySalt = randomBytes(16).toString("hex");
    account.recoveryHash = this.hash(normalizeRecoveryCode(next), account.recoverySalt);
    const token = this.newToken(account);
    this.save();
    return { ok: true, token, recoveryCode: next, account: this.info(account) };
  }

  /** AccountInfo for a live token, or undefined when the token is unknown/revoked. */
  infoFor(token: string): AccountInfo | undefined {
    const account = this.accountForToken(token);
    return account ? this.info(account) : undefined;
  }

  accountIdFor(token: string): string | undefined {
    return this.accountForToken(token)?.id;
  }

  /** Hard wipe: identity, night links and cross-night priors all go. */
  deleteByToken(token: string): boolean {
    const account = this.accountForToken(token);
    if (!account) return false;
    this.accounts.delete(account.username);
    this.failures.delete(account.username);
    this.save();
    return true;
  }

  /** Count a played night exactly once per room. */
  recordNight(accountId: string, roomId: string): AccountInfo | undefined {
    const account = this.find(accountId);
    if (!account) return undefined;
    if (!account.nights.includes(roomId)) {
      account.nights.push(roomId);
      account.nightsPlayed = account.nights.length;
      this.save();
    }
    return this.info(account);
  }

  priors(accountId: string): StoredHypothesis[] {
    return [...(this.find(accountId)?.priors ?? [])];
  }

  /** Replace the carry-over set (called at the finale, engine output only). */
  setPriors(accountId: string, priors: readonly StoredHypothesis[]): void {
    const account = this.find(accountId);
    if (!account) return;
    account.priors = priors.map((prior) => ({ ...prior, subjects: [...prior.subjects], evidence: [...prior.evidence] }));
    this.save();
  }

  clearPriors(accountId: string): void {
    const account = this.find(accountId);
    if (!account || account.priors.length === 0) return;
    account.priors = [];
    this.save();
  }

  private find(accountId: string): StoredAccount | undefined {
    for (const account of this.accounts.values()) if (account.id === accountId) return account;
    return undefined;
  }

  /** Housekeeping for tests/tools: number of stored identities. */
  get size(): number { return this.accounts.size; }

  /** Host tool: wipe the on-disk identity file entirely. */
  static removeFile(file: string): void {
    if (!existsSync(file)) return;
    try { unlinkSync(file); } catch { /* ignore */ }
  }
}

/** Contract type bridge: a stored prior is a Hypothesis whose subjects are keys. */
export const accountSubjectKey = (accountId: string, playerId: string): string => `acct:${accountId}:${playerId}`;
export const priorFromHypothesis = (h: Hypothesis, keys: string[]): StoredHypothesis => ({
  kind: h.kind, subjects: keys, status: h.status, strength: h.strength,
  evidence: [...h.evidence], openedAt: h.openedAt, ...(h.lastTestedRound ? { lastTestedRound: h.lastTestedRound } : {}),
});

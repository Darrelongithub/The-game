// src/lib/session.ts — the ONLY place the phone remembers its room seat.
// localStorage survives a reload (and a replacement tab on the same phone).
// The contract's room code, player id and resume token are stored as code/you/
// secret. Answers and secret decks stay server-side, never in browser storage.
import type { Consent, PlayerId, ProfileAnswers, RoomCode } from "@shared/contracts.ts";

const SESSION_KEY = "reveal.session";
const INTRO_KEY = "reveal.intro-done";

export interface StoredSession {
  code: RoomCode;
  you: PlayerId;
  secret: string;
  alias?: string;
  /** Preserve the original choices when resuming; never re-opt-in by rote. */
  consent?: Consent;
  profile?: ProfileAnswers;
  /** Private nonce for an in-flight token rotation; cleared on acknowledgement. */
  resumeNonce?: string;
}

const alive = (): boolean => typeof window !== "undefined";
const validSession = (value: unknown): value is StoredSession => {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<StoredSession>;
  return typeof session.code === "string" && session.code.length > 0 &&
    typeof session.you === "string" && session.you.length > 0 &&
    typeof session.secret === "string" && session.secret.length > 0;
};
function storage(kind: "localStorage" | "sessionStorage"): Storage | undefined {
  try { return window[kind]; } catch { return undefined; }
}
function read(storage: Storage | undefined): StoredSession | null {
  try {
    const raw = storage?.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return validSession(parsed) ? parsed : null;
  } catch { return null; }
}

export function loadSession(): StoredSession | null {
  if (!alive()) return null;
  const current = read(storage("localStorage"));
  if (current) return current;
  // Migrate an existing tab without asking its player to join a second seat.
  const legacy = read(storage("sessionStorage"));
  if (legacy && saveSession(legacy)) {
    // saveSession may have fallen back to sessionStorage. Only retire the
    // legacy copy once the durable store actually contains the same seat.
    const migrated = read(storage("localStorage"));
    if (migrated?.code === legacy.code && migrated.you === legacy.you && migrated.secret === legacy.secret) {
      try { storage("sessionStorage")?.removeItem(SESSION_KEY); } catch { /* best effort */ }
    }
  }
  return legacy;
}

export function saveSession(session: StoredSession): boolean {
  if (!alive()) return false;
  const raw = JSON.stringify(session);
  try {
    window.localStorage.setItem(SESSION_KEY, raw);
    if (window.localStorage.getItem(SESSION_KEY) === raw) {
      try { window.sessionStorage.removeItem(SESSION_KEY); } catch { /* optional migration */ }
      return true;
    }
  } catch { /* Private mode / quota: keep the existing tab-only fallback. */ }
  try {
    window.sessionStorage.setItem(SESSION_KEY, raw);
    return window.sessionStorage.getItem(SESSION_KEY) === raw;
  } catch { return false; }
}

export function clearSession(): void {
  if (!alive()) return;
  // Always clear BOTH stores, including a legacy token or a failed migration.
  try { window.localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  try { window.sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

/** The intro remains tab-scoped; only the authenticated seat is persistent. */
export function introDone(): boolean {
  if (!alive()) return true;
  try { return window.sessionStorage.getItem(INTRO_KEY) === "1"; } catch { return true; }
}
export function markIntroDone(): void {
  if (!alive()) return;
  try { window.sessionStorage.setItem(INTRO_KEY, "1"); } catch { /* optional */ }
}

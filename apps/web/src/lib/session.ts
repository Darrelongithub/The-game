// src/lib/session.ts — the ONLY place the phone remembers who it is.
// sessionStorage (not localStorage): a session dies with the tab, which is
// exactly right for a party game on a borrowed phone.
import type { PlayerId, RoomCode } from "@shared/contracts.ts";

const SESSION_KEY = "reveal.session";
const INTRO_KEY = "reveal.intro-done";

export interface StoredSession {
  code: RoomCode;
  you: PlayerId;
  secret: string;
  alias?: string;
  /** Private nonce for an in-flight token rotation; cleared on acknowledgement. */
  resumeNonce?: string;
}

const alive = () => typeof window !== "undefined";

export function loadSession(): StoredSession | null {
  if (!alive()) return null;
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.code || !parsed?.you || !parsed?.secret) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(s: StoredSession): boolean {
  if (!alive()) return false;
  try {
    const raw = JSON.stringify(s);
    window.sessionStorage.setItem(SESSION_KEY, raw);
    return window.sessionStorage.getItem(SESSION_KEY) === raw;
  } catch {
    // Private mode / quota: play can continue, but reload recovery is limited.
    return false;
  }
}

export function clearSession(): void {
  if (!alive()) return;
  try {
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** ui-system-FIXES #2: the opening sequence plays ONCE per session. */
export function introDone(): boolean {
  if (!alive()) return true;
  try {
    return window.sessionStorage.getItem(INTRO_KEY) === "1";
  } catch {
    return true; // can't persist → never trap the player behind the intro
  }
}

export function markIntroDone(): void {
  if (!alive()) return;
  try {
    window.sessionStorage.setItem(INTRO_KEY, "1");
  } catch {
    /* ignore */
  }
}

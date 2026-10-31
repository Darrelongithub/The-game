// apps/web/src/lib/account.ts
// ROUND 4 — optional accounts on the client. Guests never call any of this.
//
// The token is the ONLY thing kept on the device (localStorage). There is no
// email field, no password reset by message: the one-time recovery code shown
// at signup is the recovery story, and the UI must say so plainly.
import type { AccountInfo } from "@shared/contracts.ts";

const TOKEN_KEY = "reveal.account.token";
const ALIAS_KEY = "reveal.account.alias";

export interface AccountSession { token: string; account: AccountInfo; }

const readToken = (): string | null => {
  try { return window.localStorage.getItem(TOKEN_KEY); } catch { return null; }
};
const writeToken = (token: string | null): void => {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else { window.localStorage.removeItem(TOKEN_KEY); window.localStorage.removeItem(ALIAS_KEY); }
  } catch { /* private mode: accounts simply stay off */ }
};

/** Last alias this account played under — the per-night suggestion, never forced. */
export const suggestedAlias = (): string => {
  try { return window.localStorage.getItem(ALIAS_KEY) ?? ""; } catch { return ""; }
};
export const rememberAlias = (alias: string): void => {
  try { window.localStorage.setItem(ALIAS_KEY, alias.trim()); } catch { /* ignore */ }
};

export const accountToken = readToken;

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const response = await fetch(path, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await response.json()) as T & { ok?: boolean; error?: string };
    if (!response.ok || data.ok === false) return { ok: false, error: data.error ?? "That did not work." };
    return { ok: true, data };
  } catch {
    return { ok: false, error: "No connection to the game server." };
  }
}

/** Signup. `recoveryCode` is returned ONCE — show it, do not store it for them. */
export async function createAccount(username: string, pin: string): Promise<{ ok: true; session: AccountSession; recoveryCode: string } | { ok: false; error: string }> {
  const result = await call<AccountSession & { recoveryCode: string }>("POST", "/api/account", { username, pin });
  if (!result.ok) return result;
  writeToken(result.data.token);
  return { ok: true, session: { token: result.data.token, account: result.data.account }, recoveryCode: result.data.recoveryCode };
}

export async function login(username: string, pin: string): Promise<{ ok: true; session: AccountSession } | { ok: false; error: string }> {
  const result = await call<AccountSession>("POST", "/api/account/login", { username, pin });
  if (!result.ok) return result;
  writeToken(result.data.token);
  return { ok: true, session: { token: result.data.token, account: result.data.account } };
}

export async function recover(username: string, recoveryCode: string): Promise<{ ok: true; session: AccountSession; recoveryCode: string } | { ok: false; error: string }> {
  const result = await call<AccountSession & { recoveryCode: string }>("POST", "/api/account/recover", { username, recoveryCode });
  if (!result.ok) return result;
  writeToken(result.data.token);
  return { ok: true, session: { token: result.data.token, account: result.data.account }, recoveryCode: result.data.recoveryCode };
}

export async function currentAccount(): Promise<AccountInfo | null> {
  const token = readToken();
  if (!token) return null;
  const result = await call<{ account: AccountInfo }>("GET", "/api/account", undefined, token);
  return result.ok ? result.data.account : null;
}

/**
 * Attach tonight's room to the account (so `nightsPlayed` counts and the night's
 * unresolved suspicions can carry over). Proof is the player's own session
 * secret from `join` — a room code alone cannot attach anybody.
 */
export async function attachNight(input: { roomCode: string; playerId: string; playerSecret: string }): Promise<boolean> {
  const token = readToken();
  if (!token) return false;
  const result = await call<{ ok: boolean }>("POST", "/api/account/night", input, token);
  return result.ok;
}

/** Hard wipe: identity, night links and carried suspicions all go. */
export async function deleteAccount(): Promise<boolean> {
  const token = readToken();
  if (!token) return true;
  const result = await call<{ deleted: boolean }>("DELETE", "/api/account", { confirm: "delete" }, token);
  if (result.ok) writeToken(null);
  return result.ok;
}

export const signOut = (): void => writeToken(null);

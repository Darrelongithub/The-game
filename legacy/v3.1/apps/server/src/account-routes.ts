// apps/server/src/account-routes.ts
// ROUND 4 — the REST half of accounts, on the GAME server (same origin, no
// CORS, no third party). Guest play never touches any of this.
//
//   POST   /api/account          { username, pin }        → token + ONE-TIME recovery code
//   POST   /api/account/login    { username, pin }        → token
//   POST   /api/account/recover  { username, recoveryCode }→ token + new recovery code
//   GET    /api/account          (Bearer token)           → AccountInfo
//   POST   /api/account/night    { roomCode, playerId, playerSecret } → bind this room to the account
//   DELETE /api/account          (Bearer token, { confirm: "delete" }) → hard wipe
//
// Deliberately absent: any email/phone field, any "send me a link", any
// password-reset-by-message. The recovery code IS the recovery story.
import type { Express, Request, Response } from "express";
import type { AccountStore } from "./accounts.ts";

const BODY_KEYS: Record<string, readonly string[]> = {
  "POST /api/account": ["username", "pin"],
  "POST /api/account/login": ["username", "pin"],
  "POST /api/account/recover": ["username", "recoveryCode"],
  "POST /api/account/night": ["roomCode", "playerId", "playerSecret"],
  "DELETE /api/account": ["confirm"],
};

/** Tokens ride `Authorization: Bearer …`; nothing private ever rides a URL. */
const bearer = (req: Request): string => {
  const header = req.headers.authorization;
  if (typeof header !== "string") return "";
  const match = header.match(/^Bearer\s+(.+)$/iu);
  return match?.[1]?.trim() ?? "";
};

/** Unknown fields are refused rather than silently stored. */
const onlyAllowed = (body: unknown, allowed: readonly string[]): body is Record<string, unknown> =>
  !!body && typeof body === "object" && !Array.isArray(body) && Object.keys(body as object).every((key) => allowed.includes(key));

export interface AccountRouteOptions {
  store: AccountStore;
  /** Bind a joined player to an account (the room manager validates the secret). */
  bindPlayer: (input: { roomCode: string; playerId: string; playerSecret: string; accountId: string }) => boolean;
}

export function mountAccountRoutes(app: Express, options: AccountRouteOptions): void {
  const { store } = options;
  const fail = (res: Response, status: number, error: string): void => { res.status(status).json({ ok: false, error }); };

  const handler = (route: string, fn: (req: Request, res: Response, body: Record<string, unknown>) => void) => {
    const [method, path] = route.split(" ") as [string, string];
    app[method.toLowerCase() as "post" | "get" | "delete"](path, (req: Request, res: Response) => {
      const body = method === "GET" ? {} : req.body ?? {};
      const allowed = BODY_KEYS[route];
      if (allowed && !onlyAllowed(body, allowed)) return fail(res, 400, "Unsupported field.");
      res.setHeader("Cache-Control", "no-store");
      try { fn(req, res, body); } catch { fail(res, 500, "Account service unavailable."); }
    });
  };

  handler("POST /api/account", (_req, res, body) => {
    const result = store.create(body.username, body.pin);
    if (!result.ok) return fail(res, 400, result.error);
    // recoveryCode appears here and nowhere else, ever.
    res.status(201).json({ ok: true, token: result.token, recoveryCode: result.recoveryCode, account: result.account });
  });

  handler("POST /api/account/login", (_req, res, body) => {
    const result = store.login(body.username, body.pin);
    if (!result.ok) return fail(res, 401, result.error);
    res.json(result);
  });

  handler("POST /api/account/recover", (_req, res, body) => {
    const result = store.recover(body.username, body.recoveryCode);
    if (!result.ok) return fail(res, 401, result.error);
    res.json({ ok: true, token: result.token, recoveryCode: result.recoveryCode, account: result.account });
  });

  handler("GET /api/account", (req, res) => {
    const account = store.infoFor(bearer(req));
    if (!account) return fail(res, 401, "Not signed in.");
    res.json({ ok: true, account });
  });

  handler("POST /api/account/night", (req, res, body) => {
    const accountId = store.accountIdFor(bearer(req));
    if (!accountId) return fail(res, 401, "Not signed in.");
    const roomCode = typeof body.roomCode === "string" ? body.roomCode.toUpperCase() : "";
    const playerId = typeof body.playerId === "string" ? body.playerId : "";
    const playerSecret = typeof body.playerSecret === "string" ? body.playerSecret : "";
    if (!roomCode || !playerId || !playerSecret) return fail(res, 400, "Room, player and session required.");
    if (!options.bindPlayer({ roomCode, playerId, playerSecret, accountId })) return fail(res, 404, "That session is not in that room.");
    res.json({ ok: true });
  });

  handler("DELETE /api/account", (req, res, body) => {
    if (body.confirm !== "delete") return fail(res, 400, "Deletion must be confirmed.");
    if (!store.deleteByToken(bearer(req))) return fail(res, 401, "Not signed in.");
    res.json({ ok: true, deleted: true });
  });
}

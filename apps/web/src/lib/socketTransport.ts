// src/lib/socketTransport.ts — the real transport (socket.io v4).
//
// Ship rules baked in here (spec §8, §11.11):
//  • same-origin by default — the exported site is served BY the game server,
//    so there is no CORS and never a localhost call from the browser;
//  • polling-first (`["polling","websocket"]`) — flaky mobile data loves
//    polling handshakes, then upgrades;
//  • auto-reconnect with capped backoff;
//  • re-join with the stored session secret on `visibilitychange` and on every
//    socket reconnect → full snapshot, no diff replay;
//  • stale `seq` snapshots are dropped.
import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  Consent,
  DarePassRequest,
  JoinReply,
  JoinRequest,
  PlayerId,
  RoomCode,
  ServerToClientEvents,
  SubmitRequest,
} from "@shared/contracts.ts";
import { clearSession, loadSession, saveSession } from "./session";
import type { Transport, TransportHandlers } from "./transport";

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const ACK_TIMEOUT_MS = 12_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NONCE_PATTERN = /^[a-f0-9]{32}$/;

/** Never use Math.random for a credential. Older browsers can use the
 * legacy same-socket retry when secure random bytes are unavailable. */
function resumeNonce(): string | undefined {
  try {
    if (!globalThis.crypto?.getRandomValues) return undefined;
    return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch { return undefined; }
}

export class SocketTransport implements Transport {
  readonly mode = "socket" as const;

  private socket: GameSocket | null = null;
  private handlers: TransportHandlers = {};
  private lastSeq = -1;
  private lastJoin: { code: RoomCode; alias: string; playerId: PlayerId; secret: string; resumeNonce?: string } | null = null;
  private resuming = false;
  private resumeWanted = false;
  private boundVisibility = false;
  private everConnected = false;
  private resumeAttempt = 0;
  private readonly onVisibility = () => {
    if (document.visibilityState !== "visible" || !this.socket) return;
    if (!this.socket.connected) {
      this.socket.connect();
    } else if (this.lastJoin?.secret) {
      this.resume();
    }
  };

  constructor(private readonly ackTimeoutMs = ACK_TIMEOUT_MS) {
    // sessionStorage is the source of truth for a reloaded tab.
    const stored = loadSession();
    if (stored) {
      this.lastJoin = {
        code: stored.code,
        alias: stored.alias ?? "",
        playerId: stored.you,
        secret: stored.secret,
        ...(stored.resumeNonce && NONCE_PATTERN.test(stored.resumeNonce) && TOKEN_PATTERN.test(stored.secret) ? { resumeNonce: stored.resumeNonce } : {}),
      };
      this.resumeWanted = true;
    }
    this.connect();
  }

  setHandlers(handlers: TransportHandlers): void {
    this.handlers = handlers;
  }

  // ---------------------------------------------------------------- socket
  private url(): string | undefined {
    // Browser traffic must stay same-origin, including under the dev proxy;
    // a localhost override would address the player's phone, not the host.
    // The explicit URL is retained only for headless transport tests in Node.
    if (typeof window !== "undefined" && window.location) return undefined;
    const explicit = process.env.NEXT_PUBLIC_SERVER_URL;
    return explicit && explicit.length > 0 ? explicit : undefined;
  }

  private connect(): void {
    if (this.socket) return;
    const socket: GameSocket = io(this.url(), {
      transports: ["polling", "websocket"],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 700,
      reconnectionDelayMax: 6_000,
      randomizationFactor: 0.4,
      timeout: 12_000,
      withCredentials: true,
    });
    this.socket = socket;
    this.wire(socket);
    this.bindVisibility();
  }

  private wire(socket: GameSocket): void {
    socket.on("connect", () => {
      const isReconnect = this.everConnected;
      this.everConnected = true;
      this.handlers.onConnection?.(true, { resuming: this.resuming });
      // Rejoin after a drop (or a fresh boot with a stored session).
      if ((isReconnect || this.resumeWanted) && this.lastJoin?.secret) this.resume();
    });

    socket.on("disconnect", () => {
      // A lost acknowledgement must not leave a later reconnect permanently
      // blocked behind the previous attempt.
      this.resumeAttempt++;
      this.resuming = false;
      this.resumeWanted = Boolean(this.lastJoin);
      this.handlers.onConnection?.(false, { resuming: false });
    });

    socket.on("connect_error", () => {
      this.handlers.onConnection?.(false);
    });

    socket.on("state", (view) => {
      // Stale seq dropped: a slow snapshot must never rewind the room.
      if (typeof view.seq === "number") {
        if (view.seq <= this.lastSeq) return;
        this.lastSeq = view.seq;
      }
      this.handlers.onState?.(view);
    });

    socket.on("round", (view) => this.handlers.onRound?.(view));
    socket.on("reveal", (view) => this.handlers.onReveal?.(view));
    socket.on("interlude", (view) => this.handlers.onInterlude?.(view));
    socket.on("finale", (view) => this.handlers.onFinale?.(view));
    socket.on("secrets", (deck) => this.handlers.onSecrets?.(deck));
    socket.on("deleted", () => {
      this.resumeAttempt++;
      this.lastJoin = null;
      this.lastSeq = -1;
      this.resuming = false;
      this.resumeWanted = false;
      clearSession();
      this.handlers.onDeleted?.();
    });
    socket.on("error", (e) => this.handlers.onError?.(e));
  }

  private bindVisibility(): void {
    if (this.boundVisibility || typeof document === "undefined") return;
    this.boundVisibility = true;
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  /** Resolves once the socket is connected (or rejects on timeout). */
  private ready(): Promise<GameSocket> {
    this.connect();
    const socket = this.socket!;
    if (socket.connected) return Promise.resolve(socket);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off("connect", onConnect);
        reject(new Error("Could not reach the game server. Check you're on the same WiFi."));
      }, ACK_TIMEOUT_MS);
      const onConnect = () => {
        clearTimeout(timer);
        resolve(socket);
      };
      socket.once("connect", onConnect);
    });
  }

  // A timed-out create/join may have occupied a seat without delivering its
  // secret. Detach that socket so the player can try again instead of becoming
  // stuck in an unknown room.
  private abandonUnacknowledgedJoin(socket: GameSocket): void {
    if (this.socket !== socket) return;
    socket.disconnect();
    this.socket = null;
    this.everConnected = false;
    this.connect();
  }

  // ----------------------------------------------------------------- API
  async create(alias: string, consent: Consent): Promise<JoinReply & { code?: RoomCode }> {
    const socket = await this.ready();
    const reply = await new Promise<JoinReply & { code?: RoomCode }>((resolve) => {
      socket.timeout(this.ackTimeoutMs).emit("create", { alias, consent }, (error, r) => {
        if (error) {
          this.abandonUnacknowledgedJoin(socket);
          resolve({ ok: false, error: "The server did not answer. Please try again." });
        } else resolve(r && typeof r.ok === "boolean" ? r : { ok: false, error: "Invalid server reply." });
      });
    });
    this.remember(reply, alias);
    return reply;
  }

  async join(req: JoinRequest): Promise<JoinReply> {
    const socket = await this.ready();
    const reply = await new Promise<JoinReply>((resolve) => {
      socket.timeout(this.ackTimeoutMs).emit("join", req, (error, r) => {
        if (error) {
          this.abandonUnacknowledgedJoin(socket);
          resolve({ ok: false, error: "The server did not answer. Please try again." });
        } else resolve(r && typeof r.ok === "boolean" ? r : { ok: false, error: "Invalid server reply." });
      });
    });
    this.remember(reply, req.alias);
    return reply;
  }

  private remember(reply: JoinReply & { code?: RoomCode }, alias: string): void {
    if (!reply?.ok || !reply.you || !reply.secret) return;
    const code = reply.code ?? reply.state?.code ?? this.lastJoin?.code;
    if (!code) return;
    this.lastJoin = { code, alias, playerId: reply.you, secret: reply.secret };
    this.resumeWanted = false;
    if (reply.state?.seq !== undefined) this.lastSeq = reply.state.seq;
    saveSession({ code, you: reply.you, secret: reply.secret, alias });
  }

  async submit(req: SubmitRequest): Promise<{ ok: boolean; error?: string }> {
    const socket = await this.ready();
    return new Promise((resolve) => {
      socket.timeout(this.ackTimeoutMs).emit("submit", req, (error, reply) => {
        if (error) {
          // The server may have saved the answer despite the lost ack. Refresh
          // the authoritative snapshot before the player retries.
          this.resume();
          resolve({ ok: false, error: "The server did not answer. Please try again." });
        } else resolve(reply && typeof reply.ok === "boolean" ? reply : { ok: false, error: "Invalid server reply." });
      });
    });
  }

  async darePass(req: DarePassRequest): Promise<{ ok: boolean; error?: string }> {
    const reason = req.reason.trim();
    if (!reason || reason.length > 140) return { ok: false, error: "A reason of up to 140 characters is required." };
    const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Use the acknowledged submission route rather than assuming a fire-and-
    // forget dare_pass event succeeded.
    return this.submit({ roundId: req.roundId, clientUuid: `pass-${uuid}`, value: { kind: "dare", status: "passed", reason } });
  }

  start(): void { this.socket?.emit("start"); }
  addBot(): void { this.socket?.emit("add_bot"); }
  skipRound(): void { this.socket?.emit("skip_round"); }
  customPrompts(lines: string[]): void { this.socket?.emit("custom_prompts", { lines }); }
  voteHeatDown(): void { this.socket?.emit("vote_heat_down"); }
  deleteRoom(): void { this.socket?.emit("delete_room"); }

  resume(): void {
    this.tryResume(true);
  }

  private tryResume(allowSameSocketRetry: boolean): void {
    if (!this.lastJoin?.secret) {
      // Retry must also work before a player has joined a room.
      this.connect();
      if (!this.socket?.connected) this.socket?.connect();
      return;
    }
    if (this.resuming) return;
    const socket = this.socket;
    if (!socket || !socket.connected) {
      // will re-resume on the next `connect`
      this.resumeWanted = true;
      socket?.connect();
      return;
    }
    // Persist a fresh, unpredictable retry nonce *before* the request leaves.
    // If storage is unavailable, stick to the legacy same-socket exchange;
    // never send a nonce that a reload cannot reproduce.
    if (!this.lastJoin.resumeNonce && TOKEN_PATTERN.test(this.lastJoin.secret)) {
      const nonce = resumeNonce();
      if (nonce && saveSession({ code: this.lastJoin.code, you: this.lastJoin.playerId, secret: this.lastJoin.secret, alias: this.lastJoin.alias, resumeNonce: nonce })) {
        this.lastJoin.resumeNonce = nonce;
      }
    }
    const proof = this.lastJoin.resumeNonce ? `rr1.${this.lastJoin.secret}.${this.lastJoin.resumeNonce}` : this.lastJoin.secret;
    this.resuming = true;
    this.resumeWanted = false;
    const attempt = ++this.resumeAttempt;
    this.handlers.onConnection?.(true, { resuming: true });
    socket.timeout(this.ackTimeoutMs).emit(
      "join",
      {
        roomCode: this.lastJoin.code,
        alias: this.lastJoin.alias || "Player",
        consent: { age: true, terms: true, revealOptIn: true },
        resume: { playerId: this.lastJoin.playerId, secret: proof },
      },
      (error, reply) => {
        if (attempt !== this.resumeAttempt) return;
        this.resuming = false;
        if (error) {
          // Retry the same nonce-bound request on this connection. If the
          // socket drops, the persisted request is retried on reconnect.
          if (allowSameSocketRetry && socket.connected) {
            this.tryResume(false);
            return;
          }
          this.handlers.onError?.({ code: "resume_timeout", message: "The room did not answer. Please retry." });
          this.handlers.onConnection?.(false, { resuming: false });
          return;
        }
        if (!reply?.ok) {
          this.lastJoin = null;
          clearSession();
          this.handlers.onError?.({
            code: "resume_failed",
            message: reply?.error ?? "Could not rejoin the room.",
          });
          // The socket is connected even though this particular seat expired.
          this.handlers.onConnection?.(true, { resuming: false });
          return;
        }
        if (reply.secret) {
          this.lastJoin = { ...this.lastJoin!, secret: reply.secret, resumeNonce: undefined };
          saveSession({
            code: this.lastJoin.code,
            you: this.lastJoin.playerId,
            secret: reply.secret,
            alias: this.lastJoin.alias,
          });
        }
        this.handlers.onConnection?.(true, { resuming: false });
        if (reply.state) {
          if (typeof reply.state.seq === "number") {
            if (reply.state.seq <= this.lastSeq && reply.state.seq !== this.lastSeq) return;
            this.lastSeq = reply.state.seq;
          }
          this.handlers.onState?.(reply.state);
        }
      }
    );
  }

  forgetSession(): void {
    this.lastJoin = null;
    this.lastSeq = -1;
    this.resuming = false;
    this.resumeWanted = false;
    this.resumeAttempt++;
    clearSession();
    // A server-side socket can occupy only one seat. Reconnect without the old
    // seat so "start over" can actually create or join another room.
    this.socket?.disconnect();
    this.socket = null;
    this.everConnected = false;
    this.connect();
  }

  disconnect(): void {
    this.resumeAttempt++;
    this.resuming = false;
    this.socket?.disconnect();
    this.socket = null;
    if (this.boundVisibility && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
      this.boundVisibility = false;
    }
  }
}

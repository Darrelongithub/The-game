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
import { loadSession, saveSession } from "./session";
import type { Transport, TransportHandlers } from "./transport";

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const ACK_TIMEOUT_MS = 12_000;

export class SocketTransport implements Transport {
  readonly mode = "socket" as const;

  private socket: GameSocket | null = null;
  private handlers: TransportHandlers = {};
  private lastSeq = -1;
  private lastJoin: { code: RoomCode; alias: string; playerId: PlayerId; secret: string } | null = null;
  private resuming = false;
  private resumeWanted = false;
  private visibilityHandler: (() => void) | null = null;
  private everConnected = false;

  constructor() {
    // sessionStorage is the source of truth for a reloaded tab.
    const stored = loadSession();
    if (stored) {
      this.lastJoin = {
        code: stored.code,
        alias: stored.alias ?? "",
        playerId: stored.you,
        secret: stored.secret,
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
    // undefined → socket.io uses window.location (same origin). The exported
    // build is served by the game server, so this is the normal path.
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
      this.resuming = false;
      if (this.lastJoin?.secret) this.resumeWanted = true;
      this.handlers.onConnection?.(false);
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
    socket.on("deleted", () => this.handlers.onDeleted?.());
    socket.on("error", (e) => this.handlers.onError?.(e));
  }

  private bindVisibility(): void {
    if (this.visibilityHandler || typeof document === "undefined") return;
    this.visibilityHandler = () => {
      if (document.visibilityState !== "visible") return;
      if (!this.socket) return;
      if (!this.socket.connected) {
        this.socket.connect();
        return;
      }
      // Same socket, but the phone was asleep: take a fresh snapshot anyway.
      if (this.lastJoin?.secret) this.resume();
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);
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

  // ----------------------------------------------------------------- API
  async create(alias: string, consent: Consent): Promise<JoinReply & { code?: RoomCode }> {
    const socket = await this.ready();
    const reply = await new Promise<JoinReply & { code?: RoomCode }>((resolve) => {
      socket.emit("create", { alias, consent }, (r) => resolve(r));
    });
    this.remember(reply, alias);
    return reply;
  }

  async join(req: JoinRequest): Promise<JoinReply> {
    const socket = await this.ready();
    const reply = await new Promise<JoinReply>((resolve) => {
      socket.emit("join", req, (r) => resolve(r));
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
      socket.emit("submit", req, (r) => resolve(r));
    });
  }

  async darePass(req: DarePassRequest): Promise<{ ok: boolean; error?: string }> {
    if (!req.reason.trim() || req.reason.length > 140) return { ok: false, error: "A reason of up to 140 characters is required." };
    // Submit already carries an acknowledgement in the frozen contract. Reuse
    // it rather than pretending the fire-and-forget dare_pass was accepted.
    return this.submit({ roundId: req.roundId, clientUuid: `pass:${req.roundId}`, value: { kind: "dare", status: "passed", reason: req.reason } });
  }

  start(): void { this.socket?.emit("start"); }
  addBot(): void { this.socket?.emit("add_bot"); }
  skipRound(): void { this.socket?.emit("skip_round"); }
  customPrompts(lines: string[]): void { this.socket?.emit("custom_prompts", { lines }); }
  voteHeatDown(): void { this.socket?.emit("vote_heat_down"); }
  deleteRoom(): void { this.socket?.emit("delete_room"); }

  resume(): void {
    // Rejoins rotate the server secret. Duplicate visibility/connect events
    // must not race two joins with the same token.
    if (this.resuming || !this.lastJoin?.secret) return;
    const socket = this.socket;
    if (!socket || !socket.connected) {
      // will re-resume on the next `connect`
      this.resumeWanted = true;
      socket?.connect();
      return;
    }
    this.resuming = true;
    this.handlers.onConnection?.(true, { resuming: true });
    socket.emit(
      "join",
      {
        roomCode: this.lastJoin.code,
        alias: this.lastJoin.alias || "Player",
        consent: { age: true, terms: true, revealOptIn: true },
        resume: { playerId: this.lastJoin.playerId, secret: this.lastJoin.secret },
      },
      (reply) => {
        this.resuming = false;
        if (!reply?.ok) {
          this.handlers.onError?.({
            code: "resume_failed",
            message: reply?.error ?? "Could not rejoin the room.",
          });
          this.handlers.onConnection?.(false);
          return;
        }
        if (reply.secret) {
          this.lastJoin = { ...this.lastJoin!, secret: reply.secret };
          saveSession({
            code: this.lastJoin.code,
            you: this.lastJoin.playerId,
            secret: reply.secret,
            alias: this.lastJoin.alias,
          });
        }
        this.handlers.onConnection?.(true);
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

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
    if (this.visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }
}

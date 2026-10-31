import express from "express";
import { existsSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";
import { Server as SocketServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "../../../packages/shared/src/contracts.ts";
import { isRoomCode } from "../../../packages/shared/src/validate.ts";
import { RoomManager, type GameOptions } from "./room.ts";
import type { SocketLike, SocketServerLike } from "./room.ts";

type SocketData = { roomCode?: string; playerId?: string; isHost?: boolean };
export interface ServerOptions extends GameOptions { webDir?: string; }

/** The LAN addresses this machine can be reached on. */
export function lanAddresses(interfaces = networkInterfaces()): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(interfaces)) for (const entry of entries ?? [])
    if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("127.")) addresses.add(entry.address);
  return [...addresses].sort();
}

/** The best LAN address to put in a QR code. */
export function selectLanAddress(interfaces = networkInterfaces()): string | undefined {
  const candidates = Object.entries(interfaces).flatMap(([name, entries]) => (entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("127."))
    .map((entry) => ({ name, address: entry.address })));
  if (!candidates.length) return undefined;
  const penalty = (name: string): number => /docker|veth|bridge|virbr|tun|tap|wireguard|tailscale|zerotier|vmnet|vbox|virtual/i.test(name) ? 2 :
    /^(wlan|wlp|wifi|wi-fi|en|eno|enp|eth|ethernet)/i.test(name) ? 0 : 1;
  return candidates.sort((a, b) => penalty(a.name) - penalty(b.name) || a.address.localeCompare(b.address))[0]!.address;
}

/**
 * The boot banner.
 *
 * `npm run host` prints TWO links:
 *   PLAYER — the link + QR every phone scans to join.
 *   HOST   — the laptop's link. The room is already bound to it; nobody types
 *            a code.
 */
export function bootBanner(port: number, host: string, interfaces = networkInterfaces(), room?: { code: string; hostToken: string }): void {
  const local = `http://localhost:${port}`;
  const ips = lanAddresses(interfaces);
  const selected = selectLanAddress(interfaces);
  const base = `http://${selected ?? ips[0] ?? `localhost:${port}`}:${port}`;

  console.log(`\nReveal Game listening on ${host}:${port}`);
  console.log(`Local: ${local}`);
  if (ips.length) for (const ip of ips) console.log(`LAN:   http://${ip}:${port}`);
  if (host === "127.0.0.1" || host === "localhost" || host === "::1")
    console.warn("HOST is loopback-only; LAN devices cannot reach this server.");

  if (room) {
    const playerUrl = `${base}/?room=${room.code}`;
    const hostUrl = `${base}/host?token=${room.hostToken}`;
    console.log(`\nPLAYER link (scan this on your phone):\n  ${playerUrl}`);
    console.log("Scan to join (same Wi-Fi / hotspot):");
    qrcode.generate(playerUrl, { small: true });
    console.log(`\nHOST link (open this on the laptop — room already bound):\n  ${hostUrl}`);
    console.log(`\nRoom code: ${room.code}`);
  }
}

function sameOrigin(origin: string | undefined, host: string | undefined, forwarded: string | string[] | undefined): boolean {
  if (!origin) return true; // Native clients and test clients may not send Origin.
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const proxyHosts = (Array.isArray(forwarded) ? forwarded : [forwarded ?? ""]).flatMap((v) => v.split(",")).map((v) => v.trim().toLowerCase());
    return [host?.toLowerCase(), ...proxyHosts].includes(url.host.toLowerCase());
  } catch { return false; }
}

export interface GameServer {
  http: HttpServer;
  io: SocketServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
  rooms: RoomManager;
  listen(port?: number, host?: string, banner?: boolean): Promise<number>;
  close(): Promise<void>;
}

export function createGameServer(options: ServerOptions = {}): GameServer {
  const webDir = resolve(options.webDir ?? fileURLToPath(new URL("../../web/out/", import.meta.url)));
  const app = express();
  app.disable("x-powered-by");
  app.use(express.static(webDir, { extensions: ["html"], index: "index.html" }));
  app.get("*", (req, res) => {
    if (/\.[a-z\d]+$/i.test(req.path)) { res.status(404).type("text/plain").send("Not found."); return; }
    const index = resolve(webDir, "index.html");
    if (existsSync(index)) res.sendFile(index);
    else res.status(200).type("text/plain").send("The web app has not been built yet. Build apps/web to create apps/web/out/.");
  });

  const http = createServer(app);
  const io = new SocketServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(http, {
    // Polling remains enabled along with WebSocket (important for mobile networks).
    transports: ["polling", "websocket"], maxHttpBufferSize: 65_536,
    allowRequest: (req, callback) => callback(null, sameOrigin(req.headers.origin, req.headers.host, req.headers["x-forwarded-host"])),
  });

  // The manager needs the io instance so it can broadcast room-wide events
  // ("deleted") back to the phones. socket.io's typed emit is narrowed to the
  // known events; the manager works in plain event names.
  const rooms = new RoomManager(io as unknown as SocketServerLike, options);
  // The night's room is created AT STARTUP and bound to the host laptop.
  const nightRoom = rooms.createRoom();

  /**
   * Adapt a socket.io socket to the manager's small surface. The typed
   * socket.io `emit` is narrowed to the known events; the manager works in
   * plain event names.
   */
  const asSocketLike = (raw: unknown): SocketLike => {
    const socket = raw as {
      id: string;
      data: SocketData;
      emit: (event: string, payload?: unknown) => unknown;
      leave: (room: string) => void;
      join: (room: string) => void;
    };
    return {
      id: socket.id,
      data: socket.data,
      get playerId() { return socket.data.playerId; },
      emit: (event: string, payload?: unknown) => { socket.emit(event, payload); },
      leave: (room: string) => socket.leave(room),
      join: (room: string) => socket.join(room),
    };
  };

  io.on("connection", (socket) => {
    const data = socket.data;

    socket.on("join", (req, reply) => {
      const code = (req.roomCode ?? "").toUpperCase();
      if (!isRoomCode(code)) { reply({ ok: false, error: "That room code does not exist." }); return; }
      const room = rooms.get(code);
      if (!room) { reply({ ok: false, error: "That room code does not exist." }); return; }

      // A reloaded tab reclaims its seat instead of taking a second one.
      if (req.resume?.playerId && req.resume.secret) {
        const player = rooms.reclaim(code, req.resume.playerId, req.resume.secret);
        if (player) {
          data.roomCode = room.code;
          data.playerId = player.id;
          socket.join(room.code);
          rooms.attachSocket(room.code, asSocketLike(socket));
          reply({ ok: true, you: player.id, secret: player.secret, state: undefined });
          rooms.broadcastState(room);
          return;
        }
      }

      const result = rooms.join(code, req.alias, req.profile, Boolean(req.consent?.age));
      if (!result.ok) { reply({ ok: false, error: result.error }); return; }
      const { room: joined, player } = result;
      data.roomCode = joined.code;
      data.playerId = player.id;
      socket.join(joined.code);
      rooms.attachSocket(joined.code, asSocketLike(socket));
      reply({ ok: true, you: player.id, secret: player.secret, state: undefined });
      rooms.broadcastState(joined);
    });

    socket.on("host_join", (req, reply) => {
      const room = rooms.roomForHostToken(req?.token ?? "");
      if (!room) { reply({ ok: false, error: "That host link is not valid." }); return; }
      data.roomCode = room.code;
      data.isHost = true;
      room.hostConnected = true;
      socket.join(room.code);
      rooms.attachSocket(room.code, asSocketLike(socket));
      reply({ ok: true, state: undefined });
      rooms.broadcastState(room);
    });

    socket.on("submit", (req, reply) => {
      const code = data.roomCode;
      const playerId = data.playerId;
      if (!code || !playerId) { reply({ ok: false, error: "You are not in a room." }); return; }
      const result = rooms.submit(code, playerId, req.value, req.roundId);
      reply(result);
    });

    socket.on("dare_pass", () => {
      // The dare answer is a normal submit with a "passed" value; this event
      // exists so a client can send a reason without a full value payload.
    });

    socket.on("lobby_ready", (req) => {
      const code = data.roomCode;
      const playerId = data.playerId;
      if (!code || !playerId) return;
      rooms.setReady(code, playerId, Boolean(req?.ready));
    });

    socket.on("ready", () => {
      const code = data.roomCode;
      const playerId = data.playerId;
      if (!code || !playerId) return;
      rooms.finalReady(code, playerId);
    });

    socket.on("start", () => {
      const code = data.roomCode;
      if (!code || !data.isHost) return;
      void rooms.start(code);
    });

    socket.on("force_results", () => {
      const code = data.roomCode;
      if (!code || !data.isHost) return;
      rooms.forceResults(code);
    });

    socket.on("add_bot", () => {
      const code = data.roomCode;
      if (!code || !data.isHost) return;
      rooms.addBot(code);
    });

    socket.on("skip_round", () => {
      const code = data.roomCode;
      if (!code || !data.isHost) return;
      rooms.skipCase(code);
    });

    socket.on("delete_room", () => {
      const code = data.roomCode;
      if (!code) return;
      rooms.deleteRoom(code);
    });

    socket.on("disconnect", () => {
      const code = data.roomCode;
      if (!code) return;
      rooms.detachSocket(code, asSocketLike(socket));
    });
  });

  return {
    http, io, rooms,
    listen: (port = 3001, host = "0.0.0.0", banner = true) => new Promise((resolvePromise, reject) => {
      const onError = (error: Error): void => reject(error);
      http.once("error", onError);
      http.listen(port, host, () => {
        http.off("error", onError);
        const address = http.address();
        if (!address || typeof address === "string") return reject(new Error("No TCP listening address"));
        if (banner) bootBanner(address.port, host, networkInterfaces(), nightRoom);
        resolvePromise(address.port);
      });
    }),
    close: async () => {
      rooms.close();
      // Drop every socket first: a lingering phone would keep the HTTP server
      // open forever on shutdown.
      io.disconnectSockets(true);
      await new Promise<void>((resolvePromise) => io.close(() => resolvePromise()));
      if (http.listening) await new Promise<void>((resolvePromise, reject) => http.close((err) => err ? reject(err) : resolvePromise()));
    },
  };
}

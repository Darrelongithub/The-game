import express from "express";
import { existsSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";
import { Server as SocketServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "../../../packages/shared/src/contracts.ts";
import { RoomManager, type GameOptions } from "./game.ts";

type SocketData = { roomCode?: string; playerId?: string };
export interface ServerOptions extends Omit<GameOptions, "dataDir"> { dataDir?: string; webDir?: string; }
export function lanAddresses(interfaces = networkInterfaces()): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(interfaces)) for (const entry of entries ?? []) {
    if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("127.")) addresses.add(entry.address);
  }
  return [...addresses].sort();
}
export function selectLanAddress(interfaces = networkInterfaces()): string | undefined {
  const candidates = Object.entries(interfaces).flatMap(([name, entries]) => (entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("127."))
    .map((entry) => ({ name, address: entry.address })));
  if (!candidates.length) return undefined;
  const penalty = (name: string): number => /docker|veth|bridge|virbr|tun|tap|wireguard|tailscale|zerotier|vmnet|vbox|virtual/i.test(name) ? 2 :
    /^(wlan|wlp|wifi|wi-fi|en|eno|enp|eth|ethernet)/i.test(name) ? 0 : 1;
  return candidates.sort((a, b) => penalty(a.name) - penalty(b.name) || a.address.localeCompare(b.address))[0]!.address;
}
export function bootBanner(port: number, host: string, interfaces = networkInterfaces()): void {
  const local = `http://localhost:${port}`, ips = lanAddresses(interfaces), selected = selectLanAddress(interfaces);
  console.log(`\nReveal Game listening on ${host}:${port}`);
  console.log(`Local: ${local}`);
  if (ips.length) {
    for (const ip of ips) console.log(`LAN:   http://${ip}:${port}`);
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") console.warn("HOST is loopback-only; LAN devices cannot reach this server.");
    console.log("Scan to join (same Wi-Fi / hotspot):");
    qrcode.generate(`http://${selected ?? ips[0]}:${port}`, { small: true });
  } else console.warn("No LAN IPv4 interface found. Connect this host to Wi-Fi or a phone hotspot.");
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
  const dataDir = options.dataDir ?? fileURLToPath(new URL("../data/", import.meta.url));
  const webDir = resolve(options.webDir ?? fileURLToPath(new URL("../../web/out/", import.meta.url)));
  const app = express(); app.disable("x-powered-by");
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
  const rooms = new RoomManager(io, { ...options, dataDir });
  return {
    http, io, rooms,
    listen: (port = 3001, host = "0.0.0.0", banner = true) => new Promise((resolvePromise, reject) => {
      const onError = (error: Error): void => reject(error);
      http.once("error", onError);
      http.listen(port, host, () => {
        http.off("error", onError);
        const address = http.address();
        if (!address || typeof address === "string") return reject(new Error("No TCP listening address"));
        if (banner) bootBanner(address.port, host);
        resolvePromise(address.port);
      });
    }),
    close: async () => {
      rooms.close();
      await new Promise<void>((resolvePromise) => io.close(() => resolvePromise()));
      if (http.listening) await new Promise<void>((resolvePromise, reject) => http.close((err) => err ? reject(err) : resolvePromise()));
    },
  };
}

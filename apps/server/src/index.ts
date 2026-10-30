import { createGameServer } from "./server.ts";

const host = process.env.HOST || "0.0.0.0";
const rawPort = process.env.PORT ?? "3001";
const port = Number(rawPort);
if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 0 || port > 65535) {
  console.error("PORT must be an integer from 0 to 65535.");
  process.exit(1);
}
const server = createGameServer(); // the default production integration
let closing = false;
const shutdown = (): void => {
  if (closing) return;
  closing = true;
  void server.close().then(() => process.exit(0), () => process.exit(1));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
server.listen(port, host).catch((error: unknown) => {
  console.error("Could not start the game server:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});

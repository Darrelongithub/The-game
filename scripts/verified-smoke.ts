/** Local-only integration harness: it runs the PRODUCTION services and
 * watches the real Socket.IO traffic from the outside.
 *
 * The oracle is deliberately independent of the game's own code paths:
 *   • every "secrets" frame is observed per RECIPIENT — a deck that reaches a
 *     socket that does not own it is a leak, and the harness fails;
 *   • the night's log is re-read from the server and the verdicts are
 *     recomputed, so the reveal is checked against the answers;
 *   • no slide may print an orientation claim ("X is gay");
 *   • only the allowed verdict kinds may appear.
 *
 * No debug endpoint and no oracle is exposed by the hosted production server.
 */
import { spawn } from "node:child_process";
import { createGameServer } from "../apps/server/src/server.ts";
import { createProductionServices } from "../apps/server/src/integratedServices.ts";
import { computeResults, assertNoOrientationLeak } from "../packages/engine/src/index.ts";
import type { LogRecord, SecretDeckView, VerdictKind } from "../packages/shared/src/contracts.ts";

// Keys explicitly disabled: this harness never calls a hosted model.
delete process.env.XAI_API_KEY;
delete process.env.GEMINI_API_KEY;

const ALLOWED_KINDS: VerdictKind[] = [
  "hates", "core", "couple", "sex", "percent", "gaycouple",
  "bodycount", "bestinbed", "besties", "rivals", "freeagent", "blindspot",
];

const services = createProductionServices();
const server = createGameServer({ services });

/** Every "secrets" frame, with the socket that received it. */
const secretFrames: { recipient: string; isHost: boolean; deck: SecretDeckView }[] = [];
/** Every "finale" frame. */
const finales: { slides: { title: string; body?: string }[] }[] = [];

server.io.on("connection", (socket) => {
  socket.onAnyOutgoing((event, ...args) => {
    if (event === "secrets") {
      secretFrames.push({
        recipient: String(socket.data.playerId ?? "unknown"),
        isHost: Boolean(socket.data.isHost),
        deck: structuredClone(args[0]) as SecretDeckView,
      });
    }
    if (event === "finale") {
      finales.push(structuredClone(args[0]) as { slides: { title: string; body?: string }[] });
    }
  });
});

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`verified smoke: ${message}`);
}

async function main(): Promise<void> {
  const port = await server.listen(0, "127.0.0.1", false);
  const room = server.rooms.nightRoom!;

  const child = spawn(process.execPath, ["--import", "tsx", "scripts/bots.ts"], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      XAI_API_KEY: "",
      GEMINI_API_KEY: "",
      SMOKE_URL: `http://127.0.0.1:${port}`,
      SMOKE_ROOM: room.code,
      SMOKE_HOST_TOKEN: room.hostToken,
    },
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value, signal) => resolve(value ?? (signal ? 1 : 0)));
  });
  check(code === 0, "the night did not play out");

  // ---- the oracle ----
  const after = server.rooms.get(room.code);
  check(after, "the room is gone");
  check(after!.log.length > 0, "the night produced answers");

  // 1. A deck only ever reaches the socket that owns it.
  for (const frame of secretFrames) {
    check(!frame.isHost, "a secret deck reached the host laptop");
    check(frame.recipient !== "unknown", "a secret deck reached an unidentified socket");
    check(frame.deck.cards.length <= 6, "a deck holds more than six cards");
    for (const card of frame.deck.cards) {
      check(card.kind !== "crush" || card.facts.join(" ").includes("like each other"), "a one-sided crush card escaped");
    }
  }
  const recipients = new Set(secretFrames.map((f) => f.recipient));
  check(recipients.size === secretFrames.length, "a socket received more than one deck");

  // 2. The reveal never prints an orientation claim.
  for (const finale of finales) {
    for (const slide of finale.slides) {
      const text = `${slide.title} ${slide.body ?? ""}`;
      check(!/\bis gay\b/i.test(text), `the reveal printed an orientation claim: "${text}"`);
      check(!/\bstraight\b|\bgay\b|\bbisexual\b/i.test(text), `the reveal printed an orientation: "${text}"`);
    }
  }

  // 3. The verdicts are only the allowed kinds, and they are data-backed.
  const meta = {
    roomId: after!.code,
    players: after!.order.map((id) => ({ id, alias: after!.players.get(id)?.alias ?? id })),
  };
  const results = computeResults(after!.log as LogRecord[], meta);
  assertNoOrientationLeak(results);
  for (const verdict of results.verdicts) {
    check(ALLOWED_KINDS.includes(verdict.kind), `an unknown verdict kind: ${verdict.kind}`);
    check(verdict.subjects.length > 0, `a verdict with no subject: ${verdict.id}`);
    check(verdict.text.length > 0, `a verdict with no copy: ${verdict.id}`);
  }

  // 4. The log never carries a profile answer.
  const logJson = JSON.stringify(after!.log);
  for (const field of ["sexuality", "attractedTo", "lookingFor"]) {
    check(!logJson.includes(field), `the log carries a profile answer: ${field}`);
  }

  console.log(`verified smoke: ${after!.log.length} answers, ${results.verdicts.length} verdicts, ${secretFrames.length} private decks`);
  console.log("VERIFIED SMOKE PASSED ✅");
}

void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await server.close();
  });

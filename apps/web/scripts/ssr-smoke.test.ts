// apps/web/scripts/ssr-smoke.test.ts
//   npx -y tsx scripts/ssr-smoke.test.ts
// Server-renders every screen once (effects skipped) — catches import cycles,
// module-scope `window` use and render-time crashes without needing a browser.
import { renderToString } from "react-dom/server";
import React from "react";
import type { RoomView, RoundView } from "@shared/contracts.ts";
import { JoinScreen } from "../src/components/JoinScreen";
import { LobbyScreen } from "../src/components/LobbyScreen";
import { LoadingScreen } from "../src/components/LoadingScreen";
import { ReadyGate } from "../src/components/ReadyGate";
import { HostScreen } from "../src/components/HostScreen";
import { QuestionScreen } from "../src/components/play/QuestionScreen";
import { ConnectionLostOverlay } from "../src/components/ConnectionLostOverlay";
import { FinaleScreen } from "../src/components/FinaleScreen";
import { SecretDeck } from "../src/components/SecretDeck";
import { demoFinale } from "../src/components/__demo__/demoFinale";
import { demoDeck } from "../src/components/__demo__/demoDeck";

let pass = 0;
const fails: string[] = [];
const ok = (name: string, cond: boolean, extra = "") => {
  if (cond) pass++;
  else {
    fails.push(name);
    console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  }
};

const view: RoomView = {
  code: "AB2C",
  phase: "play",
  players: [
    { id: "p1", alias: "Ada", connected: true, isBot: false, ready: true },
    { id: "p2", alias: "Bot 1", connected: true, isBot: true, ready: false },
    { id: "p3", alias: "Bot 2", connected: false, isBot: true, ready: false },
    { id: "p4", alias: "Bot 3", connected: true, isBot: true, ready: true },
  ],
  round: null,
  seq: 3,
  hostPresent: true,
  lobbyReady: ["p1", "p4"],
  progress: { index: 2, total: 12 },
  pickOptions: ["p2", "p3", "p4"],
};

const noop = () => {};
const asyncNoop = async () => ({ ok: false as const, error: "test" });

// ---- JoinScreen: the sign-up fields are EXACTLY the engine's ----
const joinHtml = renderToString(
  React.createElement(JoinScreen, {
    hasSession: false,
    busy: false,
    error: null,
    onJoin: asyncNoop,
  })
);
ok("JoinScreen renders the alias field", joinHtml.includes("Your alias"));
ok("JoinScreen asks for the room code", joinHtml.includes("Room code"));
ok("JoinScreen asks for age", joinHtml.includes("How old are you?"));
ok("JoinScreen asks for gender", joinHtml.includes("Gender"));
ok("JoinScreen asks for sexuality", joinHtml.includes("Sexuality"));
ok("JoinScreen asks for attraction", joinHtml.includes("Who are you attracted to?"));
ok("JoinScreen asks what you are here for", joinHtml.includes("What are you here for tonight?"));
ok("JoinScreen has NO relationship-history question", !joinHtml.includes("partners") && !joinHtml.includes("longest") && !joinHtml.includes("How many"));
ok("JoinScreen requires the 18+ tick", joinHtml.includes("or older") && joinHtml.includes('type="checkbox"'));
ok("JoinScreen says the answers stay on the server", joinHtml.includes("never printed"));
ok("JoinScreen keeps the action disabled without an alias", joinHtml.includes("disabled"));

// ---- LobbyScreen ----
const lobbyHtml = renderToString(
  React.createElement(LobbyScreen, {
    view,
    you: "p1",
    onReady: noop,
    onDelete: noop,
  })
);
ok("Lobby shows the room code big", lobbyHtml.includes("AB2C"));
ok("Lobby lists every player", view.players.every((p) => lobbyHtml.includes(p.alias)));
ok("Lobby shows ready ticks", lobbyHtml.includes("ready"));
ok("Lobby says the laptop never answers", lobbyHtml.includes("laptop never"));
ok("Lobby has no phase names", !/warmup|spicy|deep phase/i.test(lobbyHtml));

// ---- QuestionScreen: ONE question, ONE grey line, the answer controls ----
const round: RoundView = {
  roundId: "c1",
  segmentId: "c1-p0",
  index: 1,
  kind: "pick",
  promptText: "Who in this room would you take home from this party?",
  note: "About Wanjiru. They won't see this.",
  closesAt: Date.now() + 30_000,
  youSubmitted: false,
  subjectId: "p2",
  options: undefined,
  pair: undefined,
  target: undefined,
  trait: undefined,
  aboutSelf: undefined,
  submitted: [],
};
const questionHtml = renderToString(
  React.createElement(QuestionScreen, {
    round,
    view,
    you: "p1",
    onSubmit: asyncNoop,
  })
);
ok("QuestionScreen shows the question", questionHtml.includes("Who in this room would you take home"));
ok("QuestionScreen shows the grey line", questionHtml.includes("They won&#x27;t see this."));
ok("QuestionScreen has no phase names", !/warmup|spicy|deep|dare phase/i.test(questionHtml));
ok("QuestionScreen lists pick options", questionHtml.includes("Bot 1"));
ok("QuestionScreen never lists the player itself", !questionHtml.includes(">Ada<"));

// ---- LoadingScreen ----
const loadingHtml = renderToString(React.createElement(LoadingScreen, { done: 14, total: 40 }));
ok("LoadingScreen says let's test your friendship", loadingHtml.includes("Let&#x27;s test your friendship"));
ok("LoadingScreen shows the ready count", loadingHtml.includes("14") && loadingHtml.includes("40") && loadingHtml.includes("ready"));

// ---- ReadyGate ----
const gateHtml = renderToString(
  React.createElement(ReadyGate, {
    players: view.players,
    you: "p1",
    youAreReady: false,
    onReady: noop,
  })
);
ok("ReadyGate asks for the results", gateHtml.includes("Ready for the results?"));

// ---- HostScreen ----
const hostHtml = renderToString(
  React.createElement(HostScreen, {
    view,
    finale: null,
    onStart: noop,
    onForceResults: noop,
    onSkipRound: noop,
    onDelete: noop,
  })
);
ok("HostScreen shows the join QR", hostHtml.includes("QR code for the join link"));
ok("HostScreen lists the players", view.players.every((p) => hostHtml.includes(p.alias)));
ok("HostScreen has a Start button", hostHtml.includes("Start") || hostHtml.includes("Started"));
ok("HostScreen shows the progress", hostHtml.includes("cases"));

// ---- Finale + deck (unchanged theatre) ----
const finaleHtml = renderToString(React.createElement(FinaleScreen, { view: demoFinale, deck: demoDeck, roomCode: "AB2C" }));
ok("FinaleScreen renders the story", finaleHtml.includes("finale-screen"));

const deckHtml = renderToString(React.createElement(SecretDeck, { deck: demoDeck }));
ok("SecretDeck renders", deckHtml.includes("Your secret deck"));

const overlayHtml = renderToString(
  React.createElement(ConnectionLostOverlay, { connected: false, resuming: false, hasSession: true, onRetry: noop })
);
ok("ConnectionLostOverlay renders without crashing", typeof overlayHtml === "string");

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.error(fails.map((f) => `  ✗ ${f}`).join("\n"));
  process.exit(1);
}

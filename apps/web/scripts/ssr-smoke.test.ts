// apps/web/scripts/ssr-smoke.test.ts
//   npx -y tsx scripts/ssr-smoke.test.ts
// Server-renders every screen once (effects skipped) — catches import cycles,
// module-scope `window` use and render-time crashes without needing a browser.
import { renderToString } from "react-dom/server";
import React from "react";
import type { RoomView } from "@shared/contracts.ts";
import { JoinScreen } from "../src/components/JoinScreen";
import { LobbyScreen } from "../src/components/LobbyScreen";
import { ConnectionLostOverlay } from "../src/components/ConnectionLostOverlay";
import { RoundPanel } from "../src/components/play/RoundPanel";
import { InterludePanel, RevealPanel } from "../src/components/play/BeatPanels";
import { FinalePanel } from "../src/components/play/FinalePanel";
import { SecretDeck } from "../src/components/play/SecretDeck";
import type { RoundKind } from "@shared/contracts.ts";

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
  phase: "lobby",
  hostId: "p1",
  players: [
    { id: "p1", alias: "Ada", connected: true, isBot: false },
    { id: "p2", alias: "🤖 Bot 1", connected: true, isBot: true },
    { id: "p3", alias: "🤖 Bot 2", connected: false, isBot: true },
    { id: "p4", alias: "🤖 Bot 3", connected: true, isBot: true },
  ],
  round: null,
  seq: 3,
};

const noop = () => {};
const asyncNoop = async () => ({ ok: false as const, error: "test" });

// JoinScreen
const joinHtml = renderToString(
  React.createElement(JoinScreen, {
    hasSession: false,
    busy: false,
    error: null,
    onCreate: asyncNoop,
    onJoin: asyncNoop,
  })
);
ok("JoinScreen renders the alias field", joinHtml.includes("Your alias"));
ok("JoinScreen renders the 18+ gate", joinHtml.includes("or older"));
ok("JoinScreen renders both tabs", joinHtml.includes("Create a room") && joinHtml.includes("Join a room"));
ok("JoinScreen keeps the action disabled pre-consent", joinHtml.includes("disabled"));

// LobbyScreen (host view)
const lobbyHost = renderToString(
  React.createElement(LobbyScreen, {
    view, you: "p1", code: "AB2C", isHost: true, mode: "mock",
    onStart: noop, onAddBot: noop, onCustomPrompts: noop, onDelete: noop, onHeatDown: noop,
  })
);
ok("Lobby shows the room code big", lobbyHost.includes("AB2C"));
ok("Lobby lists every player", view.players.every((p) => lobbyHost.includes(p.alias)));
ok("Lobby marks the host", lobbyHost.includes("host"));
ok("Lobby exposes add-bot + custom prompts", lobbyHost.includes("Add bot") && lobbyHost.includes("Custom prompts"));
ok("Lobby start is enabled at 4 players", lobbyHost.includes("Start the night · 4 players"));

// LobbyScreen (guest view) — host controls must be absent
const lobbyGuest = renderToString(
  React.createElement(LobbyScreen, {
    view, you: "p2", code: "AB2C", isHost: false, mode: "socket",
    onStart: noop, onAddBot: noop, onCustomPrompts: noop, onDelete: noop, onHeatDown: noop,
  })
);
ok("Guest gets no host controls", !lobbyGuest.includes("Add bot") && lobbyGuest.includes("Waiting on the host"));

// Lobby below the minimum: start must be disabled
const lobbySmall = renderToString(
  React.createElement(LobbyScreen, {
    view: { ...view, players: view.players.slice(0, 2) },
    you: "p1", code: "AB2C", isHost: true, mode: "mock",
    onStart: noop, onAddBot: noop, onCustomPrompts: noop, onDelete: noop, onHeatDown: noop,
  })
);
ok("Start is disabled below MIN_PLAYERS", lobbySmall.includes("Start (needs 4+)"));

// Overlay renders nothing while connected
const overlayHtml = renderToString(
  React.createElement(ConnectionLostOverlay, { connected: true, resuming: false, onRetry: noop })
);
ok("Connection overlay stays hidden while connected", overlayHtml.length === 0);

// ---- every round kind renders without exploding -------------------------
const kinds: RoundKind[] = ["pick", "text", "shout", "rating", "ios", "minigame", "dare", "pair_dare", "debrief"];
for (const kind of kinds) {
  const round = {
    roundId: `r-${kind}`,
    index: 3,
    phase: "spicy" as const,
    kind,
    promptText: `Rendered prompt for ${kind}`,
    closesAt: Date.now() + 20_000,
    youSubmitted: false,
    ...(kind === "pair_dare" || kind === "debrief" ? { onlyPlayers: ["p1", "p2"] } : {}),
    ...(kind === "rating" ? { trait: "chaos", about: "p2" } : {}),
    ...(kind === "ios" ? { about: "p2" } : {}),
  };
  const html = renderToString(
    React.createElement(RoundPanel, {
      round: round as never,
      players: view.players,
      you: "p1",
      mustAnswer: true,
      submitted: false,
      onSubmit: noop,
      onDarePass: noop,
      onSkip: noop,
      isHost: false,
    })
  );
  ok(`RoundPanel renders ${kind}`, html.includes(`Rendered prompt for ${kind}`));
  const touchOk =
    html.includes("min-h-[48px]") ||
    html.includes("min-h-[52px]") ||
    html.includes("min-h-[110px]") ||
    html.includes("h-40 w-40");
  ok(`RoundPanel ${kind} has a 48px+ action`, touchOk);
}

// spectator view for a onlyPlayers round that excludes me
const spectateHtml = renderToString(
  React.createElement(RoundPanel, {
    round: {
      roundId: "r-spec", index: 9, phase: "debrief" as const, kind: "debrief" as const,
      promptText: "What did they admit?", closesAt: Date.now() + 20_000,
      youSubmitted: false, onlyPlayers: ["p3", "p4"],
    } as never,
    players: view.players, you: "p1", mustAnswer: false, submitted: false,
    onSubmit: noop, onDarePass: noop, onSkip: noop, isHost: false,
  })
);
ok("Spectators get the \"They're talking…\" screen", spectateHtml.includes("They&apos;re talking") || spectateHtml.includes("They&#x27;re talking"));

// interlude + reveal
const interludeHtml = renderToString(
  React.createElement(InterludePanel, {
    view: { headline: "Warmup over", sub: "Now it gets personal.", teaser: "Two of you picked the same person.", holdMs: 3200 },
    onDone: noop,
  })
);
ok("Interlude shows its digest teaser", interludeHtml.includes("Two of you picked the same person."));

const revealHtml = renderToString(
  React.createElement(RevealPanel, {
    view: { roundId: "r1", summary: "Everyone answered.", items: [{ alias: "Ada", text: "→ Bot 1" }], holdMs: 4200 },
    onDone: noop,
  })
);
ok("Reveal renders its items", revealHtml.includes("Bot 1") && revealHtml.includes("Everyone answered."));

// finale (broadcast-safe) + secret deck
const finaleHtml = renderToString(
  React.createElement(FinalePanel, {
    view: {
      slides: [
        { beat: "tease" as const, flavor: "claim" as const, title: "Nine prompts. Nobody held back.", body: "Here we go." },
      ],
      summary: { ship: "Player 1 & Player 2" },
    },
    secretCount: 3,
    onOpenSecrets: noop,
  })
);
ok("Finale renders its first slide", finaleHtml.includes("Nobody") && finaleHtml.includes("Nine"));
ok("Finale hides a private deck behind a button", finaleHtml.includes("Open my secrets"));

// a group-flavoured slide gets the Group Announcement treatment + count-up
const groupHtml = renderToString(
  React.createElement(FinalePanel, {
    view: {
      slides: [
        { beat: "land" as const, flavor: "group" as const, title: "GROUP ANNOUNCEMENT", body: "3 of 4 agreed.", numbers: { votes: 3, of: 4 } },
      ],
      summary: {},
    },
    secretCount: 0,
    onOpenSecrets: noop,
  })
);
ok("Finale renders the group-announcement treatment", groupHtml.includes("group announcement"));
ok("Finale shows vote numbers", groupHtml.includes("votes") && groupHtml.includes("of"));
ok("No secrets → no fake deck button", !groupHtml.includes("Open my secrets"));

const deckHtml = renderToString(
  React.createElement(SecretDeck, {
    deck: {
      cards: [
        { id: "s1", kind: "spark" as const, title: "Spark", facts: ["You and Bot 1 picked each other."] },
        { id: "s2", kind: "stat" as const, title: "Your night", facts: ["Dodges: 1."] },
      ],
    },
    onClose: noop,
  })
);
ok("Secret deck opens face-down", deckHtml.includes("Press and hold to open"));
ok("Secret deck never prints a fact until held", !deckHtml.includes("You and Bot 1 picked each other."));
ok("Secret deck marks this-phone-only", deckHtml.includes("only on this phone"));

console.log(
  fails.length === 0
    ? `\nALL ${pass} SSR SMOKE CHECKS PASSED ✅`
    : `\n${fails.length} FAILED / ${pass} passed ❌`
);
process.exit(fails.length === 0 ? 0 : 1);

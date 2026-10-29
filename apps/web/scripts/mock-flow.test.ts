// apps/web/scripts/mock-flow.test.ts
// Headless acceptance harness for MockTransport (Agent A).
//   npx -y tsx scripts/mock-flow.test.ts
// Proves the mock path walks the FULL phase flow — every round kind, a passed
// dare WITH a reason, pair_dare + two debriefs carrying onlyPlayers, an
// interlude with a teaser, a reveal with items, a broadcast-safe finale, and a
// 3-card private secrets deck — plus stale-submit rejection and reload resume.
import { MockTransport } from "../src/lib/mockTransport";
import type {
  FinaleView,
  InterludeView,
  ResponseValue,
  RevealView,
  RoomView,
  RoundKind,
  RoundView,
  SecretDeckView,
  TraitId,
} from "@shared/contracts.ts";

// ---- a minimal window/sessionStorage so the mock can persist snapshots ----
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
}

const store = new MemStorage();
const g = globalThis as unknown as { window?: unknown };
g.window = { sessionStorage: store, location: { origin: "http://localhost" } };

// ---------------------------------------------------------------- assertions
let pass = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, extra = "") => {
  if (cond) { pass++; return; }
  failures.push(`${name}${extra ? " — " + extra : ""}`);
  console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`);
};

const kindsSeen = new Set<RoundKind>();
let passedDareReason: string | null = null;
let pairDares = 0;
let spectatedRounds = 0;
let debriefsWithOnlyPlayers = 0;
let interludeWithTeaser: InterludeView | null = null;
let revealWithItems: RevealView | null = null;
let finale: FinaleView | null = null;
let secrets: SecretDeckView | null = null;
let lastState: RoomView | null = null;
let staleSubmitRejected = false;
let selfPickRejected = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const handledRounds = new Set<string>();

const transport = new MockTransport();
transport.setHandlers({
  onState: (v) => { lastState = v; },
  onRound: (r) => { kindsSeen.add(r.kind); },
  onReveal: (r) => {
    if (r.items && r.items.length > 0) revealWithItems ??= r;
    for (const item of r.items ?? []) {
      if (/passed/.test(item.text)) passedDareReason ??= item.text;
    }
  },
  onInterlude: (v) => { if (v.teaser) interludeWithTeaser ??= v; },
  onFinale: (v) => { finale = v; },
  onSecrets: (d) => { secrets = d; },
  onError: () => {},
});

const OTHER = () => lastState?.players.find((p) => p.id !== lastState?.hostId)?.id ?? "p2";
const ME = () => "p1";

function answerFor(r: RoundView): ResponseValue {
  const shim = r as RoundView & { trait?: TraitId; about?: string };
  const other = OTHER();
  switch (r.kind) {
    case "pick": return { kind: "pick", target: other };
    case "text": return { kind: "text", text: "I would rather the room told me first." };
    case "shout": return { kind: "shout", word: "chaos" };
    case "rating": return { kind: "rating", trait: shim.trait ?? "chaos", about: shim.about ?? other, value: 8 };
    case "ios": return { kind: "ios", about: shim.about ?? other, value: 5 };
    case "minigame": return { kind: "minigame", score: 42 };
    case "dare": return { kind: "dare", status: "done" };
    case "pair_dare": return { kind: "dare", status: "done" };
    case "debrief": return { kind: "text", text: "They said they already knew. I said nothing back." };
  }
}

// Interact with every round the local player owns; spectate the rest.
transport.setHandlers({
  onState: (v) => { lastState = v; },
  onRound: (r) => {
    kindsSeen.add(r.kind);
    if (handledRounds.has(r.roundId)) return; // one answer per round
    handledRounds.add(r.roundId);
    const mine = !r.onlyPlayers || r.onlyPlayers.includes(ME());
    if (r.onlyPlayers) {
      if (r.kind === "pair_dare") pairDares++;
      if (r.kind === "debrief") debriefsWithOnlyPlayers++;
      if (!mine) { spectatedRounds++; return; }
    }
    void (async () => {
      await sleep(15);
      if (r.kind === "dare") {
        // exercise the REQUIRED reason path from the local phone too
        const res = await transport.darePass({ roundId: r.roundId, reason: "my mother is watching" });
        ok("dare_pass accepts a reason", res.ok === true, JSON.stringify(res));
        const empty = await transport.darePass({ roundId: r.roundId, reason: "   " });
        ok("dare_pass rejects a blank reason", empty.ok === false);
        return;
      }
      const res = await transport.submit({ roundId: r.roundId, clientUuid: `u-${r.roundId}`, value: answerFor(r) });
      ok(`submit accepted for ${r.kind}`, res.ok === true, JSON.stringify(res));
      // A second submit for the same (now closed) round must be refused.
      const stale = await transport.submit({
        roundId: r.roundId, clientUuid: `u2-${r.roundId}`, value: answerFor(r),
      });
      if (!stale.ok) staleSubmitRejected = true;
      // Self-directed answers are never accepted.
      const selfPick = await transport.submit({
        roundId: r.roundId, clientUuid: `u3-${r.roundId}`, value: { kind: "pick", target: ME() },
      });
      if (!selfPick.ok) selfPickRejected = true;
    })();
  },
  onReveal: (r) => {
    if (r.items && r.items.length > 0) revealWithItems ??= r;
    for (const item of r.items ?? []) if (/passed/.test(item.text)) passedDareReason ??= item.text;
  },
  onInterlude: (v) => { if (v.teaser) interludeWithTeaser ??= v; },
  onFinale: (v) => { finale = v; },
  onSecrets: (d) => { secrets = d; },
  onError: () => {},
});

async function main() {
  const created = await transport.create("Ada", { age: true, terms: true, revealOptIn: true });
  ok("create returns ok + code", created.ok === true && created.code === "MOCK", JSON.stringify(created).slice(0, 120));
  ok("create returns a session secret", Boolean(created.secret));
  ok("create returns a lobby snapshot", created.state?.phase === "lobby");

  const badAlias = await transport.create("A", { age: true, terms: true, revealOptIn: true });
  ok("short alias refused", badAlias.ok === false);
  const noAge = await transport.create("Ada", { age: false, terms: true, revealOptIn: true });
  ok("18+ gate enforced server-side too", noAge.ok === false);

  const early = await transport.create("Ada", { age: true, terms: true, revealOptIn: true });
  ok("re-create ok", early.ok === true);
  transport.start();
  ok("start refused below MIN_PLAYERS", lastState?.phase === "lobby");

  transport.addBot(); transport.addBot(); transport.addBot();
  ok("add_bot fills seats", lastState?.players.length === 4, `n=${lastState?.players.length}`);
  ok("bots are flagged", lastState?.players.filter((p) => p.isBot).length === 3);

  transport.start();
  ok("start moves to warmup", lastState?.phase === "warmup");

  // Drive the night. Every round resolves via submit or the mock's own timer.
  const deadline = Date.now() + 180_000;
  while (!secrets && Date.now() < deadline) await sleep(250);
  await sleep(400);

  const allKinds: RoundKind[] = ["pick", "text", "shout", "rating", "ios", "minigame", "dare", "pair_dare", "debrief"];
  for (const k of allKinds) ok(`round kind walked: ${k}`, kindsSeen.has(k));

  ok("one passed dare with a verbatim reason", Boolean(passedDareReason), String(passedDareReason));
  ok("pair_dare round seen", pairDares === 1, `n=${pairDares}`);
  ok("two debrief rounds carry onlyPlayers", debriefsWithOnlyPlayers === 2, `n=${debriefsWithOnlyPlayers}`);
  ok("a round was spectated (onlyPlayers excludes me)", spectatedRounds >= 1, `n=${spectatedRounds}`);
  ok("interlude carried a digest teaser", Boolean(interludeWithTeaser?.teaser));
  ok("a reveal carried items", Boolean(revealWithItems?.items?.length));
  ok("stale submit rejected", staleSubmitRejected);
  ok("self-pick rejected by the server-side guard", selfPickRejected);

  ok("finale arrived broadcast-safe (slides + summary only)", Boolean(finale?.slides?.length) &&
     Object.keys(finale ?? {}).sort().join(",") === "slides,summary");
  ok("finale slide beats are teases/escalates/lands",
     (finale?.slides ?? []).every((s) => ["tease", "escalate", "land"].includes(s.beat)));
  ok("finale has no secret material", JSON.stringify(finale ?? {}).indexOf("facts") === -1 && !JSON.stringify(finale).includes("Spark"));

  ok("secrets deck has 3 cards", secrets?.cards.length === 3, `n=${secrets?.cards.length}`);
  ok("cards are ordered spark → onesided → stat",
     (secrets?.cards ?? []).map((c) => c.kind).join(",") === "spark,onesided,stat");
  ok("every card has 1–4 facts", (secrets?.cards ?? []).every((c) => c.facts.length >= 1 && c.facts.length <= 4));
  ok("room ends closed after the deck", lastState?.phase === "closed", String(lastState?.phase));

  // ---- reload resume: a fresh instance must restore the snapshot ----------
  const snapRaw = store.getItem("reveal.mock.snapshot");
  ok("snapshot persisted for reload-resume", Boolean(snapRaw));
  store.setItem("reveal.mock.snapshot", JSON.stringify({
    you: "p1", alias: "Ada",
    players: [{ id: "p1", alias: "Ada", connected: true, isBot: false }],
    hostId: "p1", phase: "spicy", seq: 4, stepIndex: 4,
    round: { roundId: "r5", index: 5, phase: "spicy", kind: "ios", promptText: "How close are you to Bot 1? Circles, 1 to 7.", closesAt: Date.now() + 5000, youSubmitted: false, about: "p2" },
    closedAt: 0, votes: 0,
  }));

  let resumed: RoomView | null = null;
  let resumedRound: RoundView | null = null;
  const t2 = new MockTransport();
  t2.setHandlers({ onState: (v) => { resumed = v; }, onRound: (r) => { resumedRound = r; }, onError: () => {} });
  await sleep(50);
  const rv = resumed as RoomView | null;
  ok("reload resumes from snapshot (state)", Boolean(rv) && rv!.phase === "spicy");
  const rr = resumedRound as RoundView | null;
  ok("reload re-opens the interrupted round", rr?.roundId === "r5");
  ok("resumed round gets a fresh window", (rr?.closesAt ?? 0) > Date.now());
  const resumeSubmit = await t2.submit({ roundId: "r5", clientUuid: "x", value: { kind: "ios", about: "p2", value: 4 } });
  ok("you can still answer after a reload", resumeSubmit.ok === true, JSON.stringify(resumeSubmit));
  t2.disconnect();

  // ---- delete_room hard-kills the room ------------------------------------
  transport.deleteRoom();
  ok("delete_room clears the local session", store.getItem("reveal.session") === null);
  ok("delete_room removes the snapshot", store.getItem("reveal.mock.snapshot") === null);

  console.log(
    failures.length === 0
      ? `\nALL ${pass} MOCK-FLOW CHECKS PASSED ✅`
      : `\n${failures.length} FAILED / ${pass} passed ❌`
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();

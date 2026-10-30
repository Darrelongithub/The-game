/** Contract-only integration seam. Other agents' packages can be injected by Agent Z. */
import {
  DEFAULT_WEIGHTS, SECRET_DECK_MAX, type Claim, type FinaleSlide, type LogRecord,
  type NightDigest, type PairSignal, type PlayerId, type Prompt, type PromptCoding,
  type Results, type RoomMeta, type SecretCard, type TraitId,
} from "../../../packages/shared/src/contracts.ts";
import { clusterNames, decoyPairings, decoyQuote, nameClusterTeaser } from "../../../packages/engine/src/live.ts";

export type HeatPhase = Prompt["phase"];
export interface PromptProvider {
  /** Must return an already-available bank immediately, never await a provider call. */
  forPhase(phase: HeatPhase, n: number, usedIds: ReadonlySet<string>): Prompt[];
  /** Optional provider work is kicked off in the lobby and is never awaited by play. */
  prepare?(input: { playerCount: number; usedIds: string[]; digest: NightDigest }): Promise<void>;
  dispose?(): void;
}
export interface GameServices {
  createPromptProvider(roomId?: string): PromptProvider;
  computeSignals(log: LogRecord[], meta: RoomMeta): PairSignal[];
  computeResults(signals: PairSignal[], log: LogRecord[], meta: RoomMeta): Results;
  buildNightDigest(log: LogRecord[], meta: RoomMeta): NightDigest;
  buildSecrets(results: Results, digest: NightDigest, meta: RoomMeta): Map<PlayerId, SecretCard[]>;
  buildSkeleton(results: Results, digest: NightDigest, meta?: RoomMeta): FinaleSlide[];
  writeFinale(skeleton: FinaleSlide[], decks: Map<PlayerId, SecretCard[]>, results: Results, digest: NightDigest, meta?: RoomMeta): Promise<{ slides: FinaleSlide[]; decks: Map<PlayerId, SecretCard[]> }>;
}

// Small standalone bank. Agent D's full bank/provider is injected at merge; these
// prompts keep this server testable and playable without a key or another agent.
const p = (id: string, phase: HeatPhase, kind: Prompt["kind"], text: string, coding: PromptCoding, measures: string[]): Prompt =>
  ({ id, phase, kind, text, coding, measures, asksTarget: true, source: "bank" });
const BANK: Prompt[] = [
  p("f-w1", "warmup", "pick", "Who here would rescue the group from a chaotic trip?", "friendship", ["pick"]),
  p("f-w2", "warmup", "shout", "In one word, describe {P1}'s effect on this room.", "neutral", ["shout"]),
  p("f-w3", "warmup", "minigame", "Tap it out: who in this room has the quickest fingers?", "status", ["minigame"]),
  p("f-w4", "warmup", "text", "What should someone in this room know about you?", "trust", ["text"]),
  p("f-w5", "warmup", "pick", "Who in this room would keep a group secret safe?", "trust", ["pick"]),
  p("f-s1", "spicy", "pick", "Who in this room could charm their way out of anything?", "couple", ["pick"]),
  p("f-s2", "spicy", "rating", "Rate your own chaos from one to ten for this room.", "status", ["rating"]),
  p("f-s3", "spicy", "ios", "Choose someone here: how close do your circles feel?", "friendship", ["ios"]),
  p("f-s4", "spicy", "text", "What would you tell someone here on a very honest night?", "trust", ["text"]),
  p("f-s5", "spicy", "pick", "Who here is most likely to start harmless trouble together?", "rivalry", ["pick"]),
  p("f-d1", "deep", "text", "What do you wish a person in this room understood about you?", "trust", ["text"]),
  p("f-d2", "deep", "rating", "Rate the warmth of yourself or another person here.", "friendship", ["rating"]),
  p("f-d3", "deep", "pick", "Who here would you call when things get complicated?", "friendship", ["pick"]),
  p("f-d4", "deep", "ios", "Choose someone here: how close are your lives right now?", "trust", ["ios"]),
  p("f-d5", "deep", "text", "Tell someone here what you appreciate about them.", "friendship", ["text"]),
  p("f-a1", "dare", "dare", "Give someone here a sincere, specific compliment out loud.", "friendship", ["dareCompliance"]),
  p("f-a2", "dare", "dare", "Tell someone here about a moment when they surprised you.", "trust", ["dareCompliance"]),
  p("f-a3", "dare", "pair_dare", "{P1} and {P2}: step aside and share a story you have never told this room.", "trust", ["dareCompliance", "debrief"]),
  p("f-a4", "dare", "dare", "Choose someone here and make up a harmless two-person victory dance.", "friendship", ["dareCompliance"]),
];

export class BankPromptProvider implements PromptProvider {
  forPhase(phase: HeatPhase, n: number, used: ReadonlySet<string>): Prompt[] {
    return BANK.filter((prompt) => prompt.phase === phase && !used.has(prompt.id)).slice(0, n).map((prompt) => ({ ...prompt, measures: [...prompt.measures] }));
  }
  async prepare(): Promise<void> { /* No keys or network required. */ }
}

const pairKey = (a: string, b: string): string => [a, b].sort().join("\u0000");
const words = (s: string): Set<string> => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
const similarity = (a: string, b: string): number => {
  const x = words(a), y = words(b);
  const union = new Set([...x, ...y]);
  return union.size ? [...x].filter((w) => y.has(w)).length / union.size : 0;
};
const average = (xs: number[]): number => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const aliasOf = (meta: RoomMeta, id: string): string => meta.players.find((p) => p.id === id)?.alias ?? "Someone";

/** Conservative offline implementations, replaceable by the scoring agent's pure API. */
export function computeSignals(allRecords: LogRecord[], meta: RoomMeta): PairSignal[] {
  // Decoy answers never score.
  const log = allRecords.filter((r) => r.decoy !== true);
  const out: PairSignal[] = [];
  const players = meta.players.map((p) => p.id).sort();
  for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
    const a = players[i]!, b = players[j]!;
    const picks = log.filter((r) => r.value.kind === "pick");
    const byRound = new Map<string, Map<string, string>>();
    for (const r of picks) if (r.value.kind === "pick") {
      const m = byRound.get(r.roundId) ?? new Map<string, string>(); m.set(r.playerId, r.value.target); byRound.set(r.roundId, m);
    }
    let overlap = 0, comparable = 0;
    for (const m of byRound.values()) {
      const x = m.get(a), y = m.get(b);
      if (x && y && x !== b && y !== a) { comparable++; if (x === y) overlap++; }
    }
    const directional = (from: string, to: string, coding?: PromptCoding): number => picks.filter((r) =>
      r.playerId === from && r.value.kind === "pick" && r.value.target === to && (!coding || r.coding === coding)).length;
    const mutual = (coding?: PromptCoding): number => {
      const positive = (r: LogRecord): boolean => coding ? r.coding === coding : r.coding === "couple" || r.coding === "friendship";
      const eligible = picks.filter(positive);
      const ab = coding ? directional(a, b, coding) : eligible.filter((r) => r.playerId === a && r.value.kind === "pick" && r.value.target === b).length;
      const ba = coding ? directional(b, a, coding) : eligible.filter((r) => r.playerId === b && r.value.kind === "pick" && r.value.target === a).length;
      const rounds = new Set(eligible.map((r) => r.roundId)).size;
      return Math.min(1, Math.min(ab, ba) / Math.max(1, rounds));
    };
    const deb: number[] = [];
    const byDebrief = new Map<string, Map<string, string>>();
    for (const r of log) if (r.roundKind === "debrief" && r.value.kind === "text") {
      const m = byDebrief.get(r.roundId) ?? new Map<string, string>(); m.set(r.playerId, r.value.text); byDebrief.set(r.roundId, m);
    }
    for (const m of byDebrief.values()) if (m.has(a) && m.has(b)) deb.push(similarity(m.get(a)!, m.get(b)!));
    const ios = (from: string, to: string): number => average(log.flatMap((r) => r.playerId === from && r.value.kind === "ios" && r.value.about === to ? [r.value.value] : []));
    const agreement: number[] = [];
    for (const [subject, peer] of [[a, b], [b, a]]) {
      const own = log.filter((r) => r.playerId === subject && r.value.kind === "rating" && r.value.about === "self");
      for (const r of own) if (r.value.kind === "rating") {
        const trait = r.value.trait, selfValue = r.value.value;
        const ratings = log.flatMap((q) => q.playerId === peer && q.value.kind === "rating" && q.value.about === subject && q.value.trait === trait ? [q.value.value] : []);
        if (ratings.length) agreement.push(1 - Math.abs(selfValue - average(ratings)) / 9);
      }
    }
    const pickOverlap = comparable ? overlap / comparable : 0;
    const mutualPick = mutual();
    const debriefSim = deb.length ? average(deb) : 0.5;
    const iosMean = (ios(a, b) + ios(b, a)) / 14;
    const traitAgreement = average(agreement);
    const pairScore = DEFAULT_WEIGHTS.pickOverlap * pickOverlap + DEFAULT_WEIGHTS.mutualPick * mutualPick +
      DEFAULT_WEIGHTS.debriefSim * debriefSim + DEFAULT_WEIGHTS.iosMean * iosMean + DEFAULT_WEIGHTS.traitAgreement * traitAgreement;
    out.push({ room: meta.roomId, a, b, pickOverlap, mutualPick, debriefSim, iosMean, traitAgreement, pairScore,
      coupleEvidence: mutual("couple"), friendEvidence: mutual("friendship"),
      negativeMutual: Math.max(mutual("friction"), mutual("rivalry")) });
  }
  return out;
}

function bestMatching(players: string[], signals: PairSignal[], weight: (s: PairSignal) => number, restricted: boolean): { pairs: PairSignal[]; free?: string } | null {
  const lookup = new Map(signals.map((s) => [pairKey(s.a, s.b), s]));
  let best: { pairs: PairSignal[]; free?: string; score: number } | null = null;
  const visit = (left: string[], pairs: PairSignal[], free: string | undefined, score: number): void => {
    if (!left.length) { if (!best || score > best.score) best = { pairs: [...pairs], free, score }; return; }
    const a = left[0]!;
    if (players.length % 2 && free === undefined) visit(left.slice(1), pairs, a, score);
    for (let i = 1; i < left.length; i++) {
      const s = lookup.get(pairKey(a, left[i]!));
      if (!s || (restricted && !(s.coupleEvidence > 0 || s.friendEvidence > 0))) continue;
      visit(left.slice(1, i).concat(left.slice(i + 1)), [...pairs, s], free, score + weight(s));
    }
  };
  visit([...players].sort(), [], undefined, 0);
  return best;
}

export function computeResults(signals: PairSignal[], log: LogRecord[], meta: RoomMeta): Results {
  const claims: Claim[] = [];
  const players = meta.players.map((p) => p.id);
  const ship = bestMatching(players, signals, (s) => s.pairScore, true) ?? bestMatching(players, signals, (s) => s.pairScore, false);
  const besties = bestMatching(players, signals, (s) => s.friendEvidence, true) ?? bestMatching(players, signals, (s) => s.friendEvidence, false);
  const addPair = (type: "ship" | "besties", s: PairSignal): void => {
    // No invented positive claim when the fallback has no supporting evidence.
    if (type === "ship" ? !s.coupleEvidence && !s.friendEvidence : !s.friendEvidence) return;
    const count = Number(s.mutualPick > 0) + Number(s.iosMean > 0) + Number(s.traitAgreement > 0);
    claims.push({ id: `${type}-${s.a}-${s.b}`, type, subjects: [s.a, s.b], audience: "public", confidence: count >= 3 ? "high" : count === 2 ? "med" : "low",
      evidence: [`${aliasOf(meta, s.a)} and ${aliasOf(meta, s.b)} chose each other.`], numbers: { score: s.pairScore } });
  };
  for (const s of ship?.pairs ?? []) addPair("ship", s);
  for (const s of besties?.pairs ?? []) addPair("besties", s);
  for (const s of signals) {
    if (s.coupleEvidence && meta.revealOptIn.includes(s.a) && meta.revealOptIn.includes(s.b)) {
      claims.push({ id: `spark-${s.a}-${s.b}`, type: "spark", subjects: [s.a, s.b], audience: "private", confidence: "med", evidence: ["You both picked each other."], numbers: { mutual: s.coupleEvidence } });
    }
    for (const [a, b] of [[s.a, s.b], [s.b, s.a]]) {
      const picks = (from: string, to: string): number => log.filter((r) => r.playerId === from && r.value.kind === "pick" && r.value.target === to).length;
      if (meta.revealOptIn.includes(a) && picks(a, b) >= 2 && picks(b, a) === 0) claims.push({ id: `onesided-${a}-${b}`, type: "onesided", subjects: [a, b], audience: "private", confidence: "med", evidence: [`You kept choosing ${aliasOf(meta, b)}.`], numbers: { picks: picks(a, b) } });
    }
  }
  const rounds = new Map<string, LogRecord[]>();
  for (const r of log) if (r.value.kind === "pick" && ["couple", "friendship", "trust", "status"].includes(r.coding)) rounds.set(r.roundId, [...(rounds.get(r.roundId) ?? []), r]);
  for (const [roundId, rs] of rounds) {
    const counts = new Map<string, number>();
    for (const r of rs) if (r.value.kind === "pick") counts.set(r.value.target, (counts.get(r.value.target) ?? 0) + 1);
    for (const [target, votes] of counts) if (rs.length >= 4 && votes / rs.length >= 0.7) claims.push({ id: `consensus-${roundId}`, type: "consensus", subjects: [target], audience: "public", confidence: "low", evidence: [`The room chose ${aliasOf(meta, target)}.`], numbers: { votes, of: rs.length, share: votes / rs.length } });
  }
  return { roomId: meta.roomId, claims, pairScores: signals, ...(ship?.free ? { freeAgent: ship.free } : {}), computedAt: log.reduce((n, r) => Math.max(n, r.at), 0) };
}

export function buildNightDigest(allRecords: LogRecord[], meta: RoomMeta): NightDigest {
  // Spotlight decoys answer a cover question: never quotes, latencies or gags
  // on their own — only the pairing line below may use them (ROUND 3).
  const log = allRecords.filter((r) => r.decoy !== true);
  const quotes: NightDigest["quotes"] = [], dodges: NightDigest["dodges"] = [];
  const stats: NightDigest["stats"] = {}, gags = new Map<string, number>(), dodgeCounts = new Map<string, number>();
  const seen = new Set<string>();
  let fast = Infinity, slow = -1, topScore = -1;
  for (const r of log) {
    const alias = aliasOf(meta, r.playerId);
    if (r.latencyMs < fast) { fast = r.latencyMs; stats.fastest = { alias, ms: r.latencyMs }; }
    if (r.latencyMs > slow) { slow = r.latencyMs; stats.slowest = { alias, ms: r.latencyMs }; }
    if (r.value.kind === "text" && r.roundKind !== "debrief" && r.value.text.length >= 20 && r.value.text.length <= 140 && !seen.has(r.value.text)) {
      quotes.push({ alias, text: r.value.text, context: r.promptId }); seen.add(r.value.text);
    }
    if (r.value.kind === "dare" && r.value.status === "passed" && r.value.reason) { dodges.push({ alias, reason: r.value.reason }); dodgeCounts.set(alias, (dodgeCounts.get(alias) ?? 0) + 1); }
    if (r.value.kind === "shout") { const word = r.value.word.toLocaleLowerCase(); gags.set(word, (gags.get(word) ?? 0) + 1); }
    if (r.value.kind === "minigame" && r.value.score > topScore) { topScore = r.value.score; stats.tapWar = { alias, score: topScore }; }
  }
  for (const [alias, count] of dodgeCounts) if (!stats.topDodger || count > stats.topDodger.count) stats.topDodger = { alias, count };
  const selfVsRoom: NightDigest["selfVsRoom"] = [];
  for (const player of meta.players) for (const trait of ["loyalty", "chaos", "reliability", "warmth", "honesty", "spice"] as TraitId[]) {
    const self = log.flatMap((r) => r.playerId === player.id && r.value.kind === "rating" && r.value.about === "self" && r.value.trait === trait ? [r.value.value] : []);
    const peers = log.flatMap((r) => r.playerId !== player.id && r.value.kind === "rating" && r.value.about === player.id && r.value.trait === trait ? [r.value.value] : []);
    if (self.length && peers.length) selfVsRoom.push({ alias: player.alias, trait, self: average(self), roomMean: average(peers) });
  }
  const picks = log.filter((r) => r.value.kind === "pick").length;
  // Decoy pairing is the digest's best line: the room captioned them while they
  // answered something else. It leads the quotes and adds one cluster teaser.
  const pairings = decoyPairings(allRecords, meta);
  const paired = pairings.map(decoyQuote);
  const clusterTeasers = pairings.flatMap((pairing) => {
    const teaser = nameClusterTeaser(clusterNames(pairing.captions, meta.players), pairing.subjectAlias);
    return teaser ? [teaser] : [];
  });
  return { quotes: [...paired, ...quotes].slice(0, 12), stats, runningGags: [...gags].filter(([, count]) => count > 1).map(([word, count]) => ({ word, count })),
    pickTeasers: [...clusterTeasers, ...(picks ? [`The room has already made ${picks} choices.`] : [])], dodges, selfVsRoom };
}

export function buildSecrets(results: Results, digest: NightDigest, meta: RoomMeta): Map<PlayerId, SecretCard[]> {
  const decks = new Map<PlayerId, SecretCard[]>();
  for (const player of meta.players) {
    if (!meta.revealOptIn.includes(player.id)) continue;
    const cards: SecretCard[] = [];
    for (const c of results.claims) if (c.audience === "private" && c.type === "spark" && c.subjects.includes(player.id)) {
      const other = c.subjects.find((id) => id !== player.id);
      if (other && meta.revealOptIn.includes(other)) cards.push({ id: `${c.id}-${player.id}`, kind: "spark", title: "A little spark", facts: [`You and ${aliasOf(meta, other)} chose each other.`] });
    }
    for (const c of results.claims) if (c.audience === "private" && c.type === "onesided" && c.subjects[0] === player.id) cards.push({ id: c.id, kind: "onesided", title: "Your recurring pick", facts: c.evidence.slice(0, 4) });
    const gaps = digest.selfVsRoom.filter((g) => g.alias === player.alias).sort((a, b) => Math.abs(b.self - b.roomMean) - Math.abs(a.self - a.roomMean)).slice(0, 3);
    if (gaps.length) cards.push({ id: `blind-${player.id}`, kind: "blindspot", title: "Different perspectives", facts: gaps.map((g) => `${g.trait}: you ${g.self.toFixed(1)}, room ${g.roomMean.toFixed(1)}.`) });
    const ownDodges = digest.dodges.filter((d) => d.alias === player.alias);
    const facts: string[] = [];
    if (ownDodges.length) facts.push(`You passed ${ownDodges.length} dare${ownDodges.length === 1 ? "" : "s"}.`);
    if (digest.stats.fastest?.alias === player.alias) facts.push(`Your quickest answer took ${digest.stats.fastest.ms} ms.`);
    if (digest.stats.slowest?.alias === player.alias) facts.push(`Your longest answer took ${digest.stats.slowest.ms} ms.`);
    if (facts.length) cards.push({ id: `stat-${player.id}`, kind: "stat", title: "Your night in numbers", facts });
    if (cards.length) decks.set(player.id, cards.slice(0, SECRET_DECK_MAX));
  }
  return decks;
}

export function buildSkeleton(results: Results, digest: NightDigest): FinaleSlide[] {
  const slides: FinaleSlide[] = [{ beat: "land", title: "The room has spoken" }];
  const publicClaims = results.claims.filter((c) => c.audience === "public" && c.type !== "spark" && c.type !== "onesided" && !(c.confidence === "low" && (c.type === "toxic" || c.type === "rival")));
  const push = (type: Claim["type"], title: string, three = false): void => {
    for (const c of publicClaims.filter((claim) => claim.type === type)) {
      if (three) slides.push({ beat: "tease", flavor: "claim", claimId: c.id, title }, { beat: "escalate", flavor: "claim", claimId: c.id, title: "The room noticed" });
      slides.push({ beat: "land", flavor: type === "consensus" || type === "toxic" ? "group" : "claim", claimId: c.id, title, body: c.evidence[0]?.slice(0, 140), ...(c.numbers ? { numbers: c.numbers } : {}) });
    }
  };
  push("besties", "Besties", true); push("rival", "Rivals"); push("consensus", "Room verdict"); push("blindspot", "Different perspectives");
  for (const q of digest.quotes) slides.push({ beat: "land", flavor: "quote", title: `Quote: ${q.alias}`, body: q.text });
  for (const d of digest.dodges) slides.push({ beat: "land", flavor: "dodge", title: `Dodge: ${d.alias}`, body: d.reason });
  if (digest.stats.fastest) slides.push({ beat: "land", flavor: "stat", title: "Speed runner", body: `${digest.stats.fastest.alias}: ${digest.stats.fastest.ms} ms` });
  push("toxic", "Room verdict"); push("ship", "The ship", true);
  slides.push({ beat: "land", title: "Until next time" });
  return slides;
}

export const fallbackServices: GameServices = {
  createPromptProvider: () => new BankPromptProvider(), computeSignals, computeResults, buildNightDigest, buildSecrets, buildSkeleton,
  writeFinale: async (slides, decks) => ({ slides, decks }),
};

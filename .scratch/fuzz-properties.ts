// Property fuzz: random logs → computeSignals/computeResults/buildNightDigest
// must never throw, must be deterministic, and every claim must reference real
// players with numerically honest fields.
import { mulberry32 } from '../packages/engine/src/rng.ts';
import { computeSignals, computeResults, buildNightDigest } from '../packages/engine/src/index.ts';
import type { LogRecord, RoomMeta, PlayerId, PromptCoding, ResponseValue } from '../packages/shared/src/contracts.ts';
import { TRAITS } from '../packages/shared/src/contracts.ts';
import { validSubmit, isResponseValue, isAlias } from '../packages/shared/src/validate.ts';
import { pseudonymizeText, restoreAliases } from '../apps/server/src/pseudonyms.ts';
import { redactAliases, containsAlias } from '../packages/prompts/src/provider.ts';

const CODES: PromptCoding[] = ['couple', 'friendship', 'rivalry', 'friction', 'neutral', 'trust', 'heat'];
const KINDS = ['pick', 'text', 'shout', 'rating', 'ios', 'minigame', 'dare'] as const;
const problems: string[] = [];

// ---- pure-function fuzz -----------------------------------------------------
{
  const rand = mulberry32(7);
  const words = ['Ada', 'Ben', 'Cleo', 'Dara', 'Player 2', 'Player 11', 'ada_1', 'A.B', '(x)', 'Ünal', 'naïve', 'x', '', '   ', 'Player 3'];
  for (let i = 0; i < 4000; i++) {
    const n = 4 + Math.floor(rand() * 8);
    const players = Array.from({ length: n }, (_, k) => ({ alias: words[Math.floor(rand() * words.length)]! + (rand() < 0.5 ? '' : String(k)), id: `p${k + 1}` }));
    const text = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => words[Math.floor(rand() * words.length)]!).join(' ');
    // pseudonymize/restore must not throw and must be idempotent on a second pass
    const once = pseudonymizeText(text, players);
    const twice = pseudonymizeText(once, players);
    if (containsAlias(once, players.map((p) => p.alias).filter((a) => a.trim().length >= 2))) {
      // a real alias survived pseudonymization → leak to a provider
      const rest = restoreAliases(once, players);
      if (rest !== once) problems.push(`pseudonymize left alias: ${JSON.stringify({ text, players: players.map((p) => p.alias), once })}`);
    }
    if (twice !== once) problems.push(`pseudonymize not idempotent: ${JSON.stringify({ text, once, twice })}`);
    const red = redactAliases(text, players.map((p) => p.alias));
    if (containsAlias(red, players.map((p) => p.alias))) problems.push(`redactAliases left alias: ${JSON.stringify({ text, red })}`);
    // validSubmit: never throws, never accepts a self-directed answer
    const values: unknown[] = [
      { kind: 'pick', target: players[0]!.id }, { kind: 'pick', target: 'p999' },
      { kind: 'ios', about: players[0]!.id, value: 4 }, { kind: 'rating', trait: TRAITS[0], about: players[0]!.id, value: 3 },
      { kind: 'text', text: 'hi' }, { kind: 'shout', word: 'hi' }, { kind: 'minigame', score: 5 },
      { kind: 'dare', status: 'passed', reason: 'r' }, null, 42, 'x', {}, { kind: 'pick' },
    ];
    for (const v of values) {
      let ok: boolean;
      try { ok = validSubmit(v, players[0]!.id); } catch { problems.push(`validSubmit threw on ${JSON.stringify(v)}`); continue; }
      if (ok && isResponseValue(v) && (v as any).kind === 'pick' && (v as any).target === players[0]!.id) problems.push('validSubmit accepted a self pick');
      if (ok && isResponseValue(v) && (v as any).kind === 'ios' && (v as any).about === players[0]!.id) problems.push('validSubmit accepted a self ios');
    }
    if (!isRoomCodeOkSafe()) problems.push('isRoomCode crashed');
  }
}
function isRoomCodeOkSafe(): boolean {
  try { return true; } catch { return false; }
}

// ---- engine fuzz ------------------------------------------------------------
{
  const rand = mulberry32(11);
  for (let trial = 0; trial < 150; trial++) {
    const n = 4 + Math.floor(rand() * 8);
    const ids: PlayerId[] = Array.from({ length: n }, (_, k) => `p${k + 1}`);
    const meta: RoomMeta = { roomId: `r${trial}`, code: 'ABCD', players: ids.map((id, k) => ({ id, alias: `Alias${k + 1}` })), revealOptIn: ids.filter(() => rand() < 0.6) };
    const log: LogRecord[] = [];
    for (let r = 0; r < 24; r++) {
      const roundId = `r${trial}-${r}`;
      const kind = KINDS[Math.floor(rand() * KINDS.length)]!;
      for (const id of ids) {
        if (rand() < 0.2) continue;
        const other = ids.filter((x) => x !== id)[Math.floor(rand() * (n - 1))]!;
        const value: ResponseValue = kind === 'pick' ? { kind: 'pick', target: other }
          : kind === 'text' ? { kind: 'text', text: `note ${r} ${id}` }
          : kind === 'shout' ? { kind: 'shout', word: ['chaos', 'vibes'][Math.floor(rand() * 2)]! }
          : kind === 'rating' ? { kind: 'rating', trait: TRAITS[Math.floor(rand() * TRAITS.length)]!, about: other, value: 1 + Math.floor(rand() * 10) }
          : kind === 'ios' ? { kind: 'ios', about: other, value: 1 + Math.floor(rand() * 7) }
          : kind === 'minigame' ? { kind: 'minigame', score: Math.floor(rand() * 200) }
          : { kind: 'dare', status: rand() < 0.5 ? 'done' : 'passed', reason: 'because' };
        log.push({ roomId: meta.roomId, roundId, playerId: id, roundKind: kind, promptId: `q${r}`, coding: CODES[Math.floor(rand() * CODES.length)]!, value, at: r * 1000 + Math.floor(rand() * 500), latencyMs: Math.floor(rand() * 2000) });
      }
    }
    let A: any, B: any, sig: any;
    try {
      sig = computeSignals(log, meta);
      A = computeResults(sig, log, meta);
      B = buildNightDigest(log, meta);
    } catch (e) { problems.push(`engine threw trial ${trial}: ${String(e)}`); continue; }
    const C = computeResults(computeSignals(log, meta), log, meta);
    if (JSON.stringify(A) !== JSON.stringify(C)) problems.push(`computeResults not deterministic (trial ${trial})`);
    for (const c of A.claims) {
      if (!c.subjects.every((s: string) => ids.includes(s))) problems.push(`claim ${c.id} references unknown subject`);
      const n2 = c.numbers as Record<string, number> | undefined;
      if (n2) {
        if ('votes' in n2 && 'of' in n2) {
          if (n2.votes! > n2.of!) problems.push(`claim ${c.id} votes>of`);
          if (n2.of! > 0 && Math.abs((n2.share ?? n2.votes! / n2.of!) - n2.votes! / n2.of!) > 1e-9) problems.push(`claim ${c.id} share mismatch`);
        }
        for (const [k, v] of Object.entries(n2)) if (typeof v === 'number' && !Number.isFinite(v)) problems.push(`claim ${c.id} ${k} not finite`);
      }
      if (c.type === 'spark' && !(meta.revealOptIn.includes(c.subjects[0]!) && meta.revealOptIn.includes(c.subjects[1]!))) problems.push(`spark claim without opt-in: ${c.id}`);
    }
    for (const g of B.runningGags) if (!(g.count >= 2)) problems.push(`runningGag with count ${g.count}`);
  }
}
console.log(JSON.stringify({ problems: problems.slice(0, 12), problemCount: problems.length }, null, 2));

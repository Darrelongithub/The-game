// Local-only browser-test server. Never uses real keys or the normal data dir.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGameServer } from '../../server/src/server.ts';
import { integratedServices } from '../../server/src/integratedServices.ts';

delete process.env.XAI_API_KEY;
delete process.env.GEMINI_API_KEY;
const dir = mkdtempSync(join(tmpdir(), 'reveal-browser-test-'));
const server = createGameServer({
  dataDir: dir,
  // Test-only timing: keep enough time to interact and to see the live reveals
  // land, without making automated players wait through three 90s debates.
  botDelayMs: [1200, 1600], revealHoldMs: 4500, interludeHoldMs: 900, graceMs: 250,
  roundTimers: { spotlight: 6000, verdict: 10_000 }, verdictDiscussMs: 2200,
  services: {
    ...integratedServices,
    buildSecrets(results, digest, meta) {
      const decks = integratedServices.buildSecrets(results, digest, meta);
      const guest = meta.players[1]?.id;
      // Guarantee this UI privacy branch even if randomized bot answers happen
      // not to produce a real deck. Engine ownership is tested separately.
      if (guest && !decks.has(guest)) decks.set(guest, [{ id: 'synthetic-browser-card', kind: 'stat', title: 'Test card', facts: ['Synthetic browser fixture only.'] }]);
      return decks;
    },
  },
});
const port = await server.listen(0, '127.0.0.1', false);
console.log(`BROWSER_FIXTURE_PORT=${port}`);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await server.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', close);
process.on('SIGTERM', close);

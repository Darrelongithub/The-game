# Contract change requests

AGENT-G | package.json | Add dev dependencies typescript, tsx, @types/node and socket.io-client | Root tooling and strict external socket smoke test require them.
AGENT-G | packages/shared/src/contracts.ts | Define a privileged, local-only test oracle providing per-player expected finale decks, actual secret-frame recipient/owner trace, persisted counts per (roundId, playerId, clientUuid), verbatim dare passes, joker-guard weights and victim toxic-claim confidence | Public events expose neither deck ownership, stored submit counts, dare log contents nor joker guard weights, so an external client cannot prove secret isolation or idempotent persistence; do not disclose private decks to clients.

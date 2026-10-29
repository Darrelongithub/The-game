# Contract change requests

AGENT-G | package.json | Add dev dependencies typescript, tsx, @types/node and socket.io-client | Root tooling and strict external socket smoke test require them.
AGENT-G | packages/shared/src/contracts.ts | Define a privileged, local-only test oracle providing per-player expected finale decks, actual secret-frame recipient/owner trace, persisted counts per (roundId, playerId, clientUuid), verbatim dare passes, joker-guard weights and victim toxic-claim confidence | Public events expose neither deck ownership, stored submit counts, dare log contents nor joker guard weights, so an external client cannot prove secret isolation or idempotent persistence; do not disclose private decks to clients.
AGENT-B1 | packages/shared/src/contracts.ts | Add rating trait and target, and IOS target, to RoundView | Prompt text alone cannot reliably identify the required trait or player.
AGENT-B1 | packages/shared/src/contracts.ts | Add submitted player IDs and heat-down vote count to RoomView | Waiting dots and live vote counts cannot be derived from the public snapshot.
AGENT-B1 | packages/shared/src/contracts.ts | Specify ResponseValue mapping for pair_dare and debrief | RoundKind includes these kinds but ResponseValue does not; clients need an interoperable submission contract.

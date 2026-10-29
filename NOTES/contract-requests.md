# Contract change requests

AGENT-B1 | packages/shared/src/contracts.ts | Add rating trait and target, and IOS target, to RoundView | Prompt text alone cannot reliably identify the required trait or player.
AGENT-B1 | packages/shared/src/contracts.ts | Add submitted player IDs and heat-down vote count to RoomView | Waiting dots and live vote counts cannot be derived from the public snapshot.
AGENT-B1 | packages/shared/src/contracts.ts | Specify ResponseValue mapping for pair_dare and debrief | RoundKind includes these kinds but ResponseValue does not; clients need an interoperable submission contract.

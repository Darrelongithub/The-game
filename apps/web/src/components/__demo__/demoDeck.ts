// __demo__/demoDeck.ts — hardcoded 3-card demo deck (spark → blindspot →
// stat — fixed order per spec §7). Facts ≤120 chars, numbers from demo data.
import type { SecretDeckView } from '../../../../../packages/shared/src/contracts.ts'

export const demoDeck: SecretDeckView = {
  cards: [
    {
      id: 'demo-spark',
      kind: 'spark',
      title: 'Spark, spotted',
      facts: [
        'You and Player 5 picked each other — twice.',
        'Both opted in. The room noticed. Kindly.',
      ],
    },
    {
      id: 'demo-blindspot',
      kind: 'blindspot',
      title: 'Your blind spot',
      facts: [
        'You rated your reliability 9/10.',
        'The room read it as 6/10 — spread of 3.',
      ],
    },
    {
      id: 'demo-stat',
      kind: 'stat',
      title: 'Night stats',
      facts: [
        'Fastest answer tonight: 840 ms.',
        'Passed 1 dare: “my mother is watching.”',
      ],
    },
  ],
}

// __demo__/demoDeck.ts — hardcoded 3-card demo deck (crush → blindspot →
// look chain). Facts ≤120 chars, numbers from demo data.
import type { SecretDeckView } from '../../../../../packages/shared/src/contracts.ts'

export const demoDeck: SecretDeckView = {
  cards: [
    {
      id: 'demo-crush',
      kind: 'crush',
      title: 'Mutual crush',
      facts: [
        'You and Player 5 like each other.',
        'Both of you picked. Neither of you is told who picked them.',
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
      id: 'demo-lookchain',
      kind: 'lookchain',
      title: 'Look chain',
      facts: [
        'You looked at Player 2.',
        '3 of 5 guessed right.',
      ],
    },
  ],
}

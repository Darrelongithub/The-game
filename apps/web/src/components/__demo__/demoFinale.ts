// __demo__/demoFinale.ts — hardcoded demo FinaleView for the B2 acceptance:
// title · 3-beat claim · quote · dodge · stat · group announcement with
// numbers · closing. Public copy only, pseudonyms only (spec §7).
import type { FinaleView } from '../../../../../packages/shared/src/contracts.ts'

export const demoFinale: FinaleView = {
  slides: [
    // title
    {
      beat: 'tease',
      title: 'Tonight, Rewind',
      body: 'Nine rounds. One room. Zero alibis.',
    },
    // 3-beat claim (tease → escalate → land)
    {
      beat: 'tease',
      flavor: 'claim',
      claimId: 'ship-demo',
      title: 'Player 2 × Player 5',
      body: 'Same drink ordered. Same pick. Twice in a row.',
    },
    {
      beat: 'escalate',
      flavor: 'claim',
      claimId: 'ship-demo',
      title: 'Player 2 × Player 5',
      body: 'Three matching picks and a debrief in sync. The math is blushing.',
    },
    {
      beat: 'land',
      flavor: 'claim',
      claimId: 'ship-demo',
      title: 'Player 2 × Player 5',
      body: 'SHIP: the room has spoken — you two are a package deal.',
    },
    // quote of the night
    {
      beat: 'escalate',
      flavor: 'quote',
      title: 'Player 4',
      body: 'I said what I said, and I’d say it again.',
    },
    // dodge report
    {
      beat: 'escalate',
      flavor: 'dodge',
      title: 'Player 7',
      body: 'Passed the honesty dare. Twice. “My mother is watching.”',
    },
    // speed runner (stat)
    {
      beat: 'escalate',
      flavor: 'stat',
      title: 'Speed Runner · Player 3',
      body: 'Answered before the question finished rendering.',
      numbers: { ms: 840 },
    },
    // group announcement with numbers
    {
      beat: 'land',
      flavor: 'group',
      claimId: 'toxic-demo',
      title: 'Player 7',
      body: 'The room keeps saying it about Player 7.',
      numbers: { votes: 5, of: 8, share: 63 },
    },
    // closing (always last)
    {
      beat: 'escalate',
      title: 'The room has spoken',
      body: 'Screenshot the card. Keep the receipts. Delete nothing.',
    },
  ],
  summary: {
    ship: 'Player 2 × Player 5',
    besties: 'Player 2 & Player 5',
    toxic: 'Player 7',
    rivals: 'Player 1 vs Player 6',
  },
}

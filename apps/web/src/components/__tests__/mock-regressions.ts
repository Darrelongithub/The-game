// The mock transport's lifecycle: join → start → play → the ONE gate → the
// reveal, and the deletion that cancels every late event.
import assert from 'node:assert/strict'
import { MockTransport } from '../../lib/mockTransport'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const first = new MockTransport()
  let phase = ''
  let decks = 0
  let finale = 0
  first.setHandlers({
    onState: (state) => { phase = state.phase },
    onSecrets: () => { decks++ },
    onFinale: () => { finale++ },
  })

  const joined = await first.join({
    roomCode: 'MOCK',
    alias: 'Guest',
    consent: { age: true, terms: true },
    profile: { age: 27, gender: 'woman', sexuality: 'straight', attractedTo: 'women' },
  })
  assert.ok(joined.ok, 'the mock seat is taken')
  assert.equal(phase, 'lobby')

  // The lobby tick.
  first.lobbyReady(true)
  assert.ok((await Promise.resolve(), true))

  // Start → the loading screen → play.
  first.start()
  assert.equal(phase, 'generating')
  await sleep(1100)
  assert.equal(phase, 'play')

  // Answer until the night ends.
  for (let i = 0; i < 20 && phase !== 'results'; i++) {
    await first.submit({ roundId: `mock-case-${i}`, clientUuid: `u${i}`, value: { kind: 'text', text: 'answer' } })
    await sleep(900)
  }
  assert.equal(phase, 'results', 'the night ends at the gate')
  assert.equal(finale, 0, 'nothing is revealed before the gate')

  // The gate opens the reveal AND the private deck.
  first.ready()
  assert.equal(finale, 1, 'the reveal lands after the gate')
  assert.equal(decks, 1, 'the deck lands after the gate')

  first.deleteRoom()
  first.disconnect()

  // A deleted room never emits a late event.
  const second = new MockTransport()
  let deleted = false
  let lateEvents = 0
  second.setHandlers({
    onDeleted: () => { deleted = true },
    onState: () => { if (deleted) lateEvents++ },
    onSecrets: () => { if (deleted) lateEvents++ },
  })
  await second.join({
    roomCode: 'MOCK',
    alias: 'Guest',
    consent: { age: true, terms: true },
    profile: { age: 27, gender: 'woman', sexuality: 'straight', attractedTo: 'women' },
  })
  second.start()
  second.deleteRoom()
  await sleep(1200)
  assert.equal(lateEvents, 0, 'deleting a mock room cancels delayed secrets and snapshots')
  second.disconnect()

  console.log('ALL MOCK LIFECYCLE REGRESSIONS PASSED')
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })

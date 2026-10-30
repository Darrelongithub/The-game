import assert from 'node:assert/strict'
import { MockTransport } from '../../lib/mockTransport'

async function main() {
  const values = new Map<string, string>()
  ;(globalThis as any).window = { sessionStorage: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) } }
  const consent = { age: true, terms: true, revealOptIn: true }
  const first = new MockTransport()
  let phase = '', decks = 0
  first.setHandlers({ onState: (state) => { phase = state.phase }, onSecrets: () => { decks++ } })
  await first.create('Guest', consent)
  ;(first as any).goFinale()
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(decks, 1)
  assert.equal(phase, 'finale', 'the public story and private deck must remain reachable')
  first.deleteRoom(); first.disconnect()

  const second = new MockTransport()
  let deleted = false, lateEvents = 0
  second.setHandlers({ onDeleted: () => { deleted = true }, onState: () => { if (deleted) lateEvents++ }, onSecrets: () => { if (deleted) lateEvents++ } })
  await second.create('Guest', consent)
  ;(second as any).goFinale()
  second.deleteRoom()
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(lateEvents, 0, 'deleting a mock room cancels delayed secrets and snapshots')
  assert.equal(values.has('reveal.mock.snapshot'), false, 'deletion cannot recreate a snapshot')
  second.disconnect()
  console.log('ALL MOCK LIFECYCLE REGRESSIONS PASSED')
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })

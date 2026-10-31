// The real SocketTransport against the real game server: the phone joins, the
// laptop binds, a reloaded tab reclaims its seat, and deleting the room
// forgets it.
import assert from 'node:assert/strict'
import { createGameServer } from '../../../../server/src/server.ts'
import { SocketTransport } from '../../lib/socketTransport.ts'

const profile = { age: 28, gender: 'woman' as const, sexuality: 'straight' as const, attractedTo: 'women' as const as const }
const consent = { age: true, terms: true }

async function main() {
  delete process.env.XAI_API_KEY
  delete process.env.GEMINI_API_KEY
  const server = createGameServer({})
  const port = await server.listen(0, '127.0.0.1', false)
  process.env.NEXT_PUBLIC_SERVER_URL = `http://127.0.0.1:${port}`
  const store = new Map<string, string>()
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  }
  const doc = new EventTarget() as EventTarget & { visibilityState: string }
  doc.visibilityState = 'visible'
  ;(globalThis as any).window = { sessionStorage: storage }
  ;(globalThis as any).document = doc

  let transport = new SocketTransport()
  const errors: string[] = []
  let onDeleted!: () => void
  const deleted = new Promise<void>((resolve) => { onDeleted = resolve })
  transport.setHandlers({ onError: (error) => errors.push(error.code), onDeleted })
  try {
    const room = server.rooms.nightRoom!

    // The laptop binds with its token — no code is typed.
    const bound = await transport.hostJoin(room.hostToken)
    assert.ok(bound.ok, 'the host token binds the room')

    // The phone joins with the code from the QR.
    const made = await transport.join({ roomCode: room.code, alias: 'Wanjiru', consent, profile })
    assert.ok(made.ok && made.secret, 'the phone joins')
    assert.ok(storage.getItem('reveal.session'), 'the seat is remembered for a reload')

    // A reloaded tab reclaims the seat instead of taking a new one.
    transport.resume()
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.deepEqual(errors, [], 'a resume does not error')
    assert.equal(room.players.size, 1, 'a reload does not take a second seat')

    // An underage player is refused.
    const refused = await transport.join({ roomCode: room.code, alias: 'Kid', consent, profile: { ...profile, age: 16 } })
    assert.equal(refused.ok, false, '18+ is enforced on the server')

    // A browser never uses a localhost override.
    ;(globalThis as any).window.location = { origin: 'https://phone.example' }
    assert.equal((transport as any).url(), undefined, 'browsers never use a localhost override')
    delete (globalThis as any).window.location

    transport.forgetSession()
    const fresh = await transport.join({ roomCode: room.code, alias: 'Fresh', consent, profile })
    assert.ok(fresh.ok, 'starting over detaches the old socket seat')

    transport.deleteRoom()
    await deleted
    assert.equal(storage.getItem('reveal.session'), null, 'deletion forgets the seat')
    doc.dispatchEvent(new Event('visibilitychange'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(errors, [], 'visibility cannot resume a deleted room')

    console.log('ALL SOCKET TRANSPORT REGRESSIONS PASSED')
  } finally {
    transport.disconnect()
    await server.close()
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })

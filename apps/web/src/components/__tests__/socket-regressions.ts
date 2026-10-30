// Real SocketTransport against an isolated local server, synthetic players only.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGameServer } from '../../../../server/src/server.ts'
import { SocketTransport } from '../../lib/socketTransport.ts'

const profile = { age: 28, relationship: "single" as const, partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: "vibes" as const }

async function main() {
  delete process.env.XAI_API_KEY; delete process.env.GEMINI_API_KEY
  const dir = mkdtempSync(join(tmpdir(), 'reveal-web-transport-'))
  const server = createGameServer({ dataDir: dir })
  const port = await server.listen(0, '127.0.0.1', false)
  process.env.NEXT_PUBLIC_SERVER_URL = `http://127.0.0.1:${port}`
  const store = new Map<string, string>()
  let storageBlocked = false
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { if (storageBlocked) throw new Error('storage unavailable'); store.set(k, v) }, removeItem: (k: string) => store.delete(k) }
  const doc = new EventTarget() as EventTarget & { visibilityState: string }
  doc.visibilityState = 'visible'
  let visibilityListeners = 0
  const add = doc.addEventListener.bind(doc), remove = doc.removeEventListener.bind(doc)
  doc.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: any) => {
    if (type === 'visibilitychange') visibilityListeners++
    add(type, listener, options)
  }) as typeof doc.addEventListener
  doc.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: any) => {
    if (type === 'visibilitychange') visibilityListeners--
    remove(type, listener, options)
  }) as typeof doc.removeEventListener
  ;(globalThis as any).window = { sessionStorage: storage }
  ;(globalThis as any).document = doc
  let transport = new SocketTransport()
  const errors: string[] = []
  const connections: { connected: boolean; resuming?: boolean }[] = []
  let onDeleted!: () => void
  const deleted = new Promise<void>((resolve) => { onDeleted = resolve })
  transport.setHandlers({ onError: (error) => errors.push(error.code), onDeleted,
    onConnection: (connected, info) => connections.push({ connected, resuming: info?.resuming }) })
  try {
    const made = await transport.create('Host', { age: true, terms: true, revealOptIn: false }, profile)
    assert.ok(made.ok && made.secret)
    // visibilitychange and the hook can request a snapshot at the same time.
    // They must not both spend the same single-use session secret.
    transport.resume(); transport.resume()
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.deepEqual(errors, [], 'concurrent rejoin attempts must not invalidate the session')
    const saved = JSON.parse(storage.getItem('reveal.session')!)
    assert.ok(saved.secret && saved.secret !== made.secret, 'rotated token is saved')
    transport.resume()
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.deepEqual(errors, [], 'the next resume must use the latest secret')
    assert.equal(connections.at(-1)?.resuming, false, 'a completed resume clears the reconnect overlay')

    // Intercept the real server's next acknowledgement and simulate the phone
    // reloading immediately after that rotation, before it receives the ack.
    const beforeLostAck = JSON.parse(storage.getItem('reveal.session')!)
    const serverSocket = server.io.sockets.sockets.get((transport as any).socket.id)!
    let lost!: () => void
    const ackDropped = new Promise<void>((resolve) => { lost = resolve })
    serverSocket.use((packet, next) => {
      if (packet[0] === 'join' && packet[1]?.resume && typeof packet[2] === 'function') {
        packet[2] = () => { lost() }
      }
      next()
    })
    transport.resume()
    await Promise.race([ackDropped, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('rotation ack was not dropped')), 3000))])
    const pending = JSON.parse(storage.getItem('reveal.session')!)
    assert.equal(pending.secret, beforeLostAck.secret)
    assert.match(pending.resumeNonce, /^[a-f0-9]{32}$/, 'the request nonce is persisted before the ack')
    transport.disconnect()
    transport = new SocketTransport()
    transport.setHandlers({ onError: (error) => errors.push(error.code), onDeleted,
      onConnection: (connected, info) => connections.push({ connected, resuming: info?.resuming }) })
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && JSON.parse(storage.getItem('reveal.session')!).secret === beforeLostAck.secret) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const recovered = JSON.parse(storage.getItem('reveal.session')!)
    assert.notEqual(recovered.secret, beforeLostAck.secret, 'a new socket recovers the already-rotated token')
    assert.equal(recovered.resumeNonce, undefined, 'the pending nonce is erased after acknowledgement')
    assert.deepEqual(errors, [], 'a dropped ack plus reload does not lose the seat')

    let sentProof = ''
    const quotaSocket = server.io.sockets.sockets.get((transport as any).socket.id)!
    quotaSocket.use((packet, next) => { if (packet[0] === 'join') sentProof = packet[1]?.resume?.secret ?? ''; next() })
    storageBlocked = true
    transport.resume()
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.ok(sentProof && !sentProof.startsWith('rr1.'), 'failed nonce persistence falls back to same-socket legacy retry')
    storageBlocked = false
    transport.resume()
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.deepEqual(errors, [], 'the session remains usable after storage recovers')
    ;(globalThis as any).window.location = { origin: 'https://phone.example' }
    assert.equal((transport as any).url(), undefined, 'browsers never use a localhost override')
    delete (globalThis as any).window.location
    transport.forgetSession()
    const fresh = await transport.create('Fresh host', { age: true, terms: true, revealOptIn: false }, profile)
    assert.ok(fresh.ok, 'starting over detaches the old socket seat')
    transport.deleteRoom(); await deleted
    assert.equal(storage.getItem('reveal.session'), null, 'deletion forgets the rotating token')
    doc.dispatchEvent(new Event('visibilitychange'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(errors, [], 'visibility cannot resume a deleted room')
    console.log('ALL SOCKET TRANSPORT REGRESSIONS PASSED')
  } finally {
    transport.disconnect()
    assert.equal(visibilityListeners, 0, 'disconnect removes the visibility listener')
    await server.close(); rmSync(dir, { recursive: true, force: true })
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })

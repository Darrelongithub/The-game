// The transport's timeouts against a synthetic Socket.IO peer that
// intentionally drops acknowledgements.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { SocketTransport } from '../../lib/socketTransport.ts'

const profile = { age: 28, gender: 'woman' as const, sexuality: 'straight' as const, attractedTo: 'women' as const as const }
const consent = { age: true, terms: true }

async function main() {
  const http = createServer()
  const io = new Server(http, { transports: ['polling', 'websocket'] })
  const state = { code: 'AB2C', phase: 'play', players: [{ id: 'p1', alias: 'Guest', connected: true, isBot: false, ready: true }], round: null, seq: 1 }
  let rejoins = 0, disconnects = 0, dropJoinAck = false, dropSubmitAck = false
  const submissions: any[] = []
  io.on('connection', (socket) => {
    socket.on('disconnect', () => { disconnects++ })
    socket.on('join', (request, ack) => {
      if (request.alias === 'NoAck') return
      rejoins++
      if (dropJoinAck) { dropJoinAck = false; return }
      ack({ ok: true, you: 'p1', secret: 'secret-1', state: { ...state, seq: rejoins + 1 } })
    })
    socket.on('submit', (request, ack) => {
      submissions.push(request)
      if (dropSubmitAck) { dropSubmitAck = false; return }
      ack({ ok: false, error: 'Rejected' })
    })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as { port: number }).port
  process.env.NEXT_PUBLIC_SERVER_URL = `http://127.0.0.1:${port}`
  const values = new Map<string, string>()
  ;(globalThis as any).window = { sessionStorage: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) } }
  const doc = new EventTarget() as EventTarget & { visibilityState: string }
  doc.visibilityState = 'visible'
  ;(globalThis as any).document = doc
  const transport = new (SocketTransport as any)(100) as SocketTransport
  try {
    const made = await transport.join({ roomCode: 'AB2C', alias: 'Guest', consent, profile })
    assert.ok(made.ok, 'the phone joins')

    // A submit that never gets an acknowledgement fails, and the transport
    // asks for a fresh snapshot rather than pretending it worked.
    dropSubmitAck = true
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('submit did not time out')), 700))
    const result = await Promise.race([transport.submit({ roundId: 'r1', clientUuid: 'u1', value: { kind: 'pick', target: 'p2' } }), timeout])
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /did not answer|timed out/i)

    // A rejected answer is reported as rejected.
    const rejected = await transport.submit({ roundId: 'r1', clientUuid: 'u2', value: { kind: 'pick', target: 'p2' } })
    assert.equal(rejected.ok, false)
    assert.match(rejected.error ?? '', /rejected/i)

    // A lost join acknowledgement detaches the unknown seat and can be retried.
    transport.forgetSession()
    const lostJoin = await transport.join({ roomCode: 'AB2C', alias: 'NoAck', consent, profile })
    assert.equal(lostJoin.ok, false)
    assert.match(lostJoin.error ?? '', /did not answer/i)
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.ok(disconnects >= 1, 'an unacknowledged join detaches its unknown seat')
    assert.ok((await transport.join({ roomCode: 'AB2C', alias: 'Guest', consent, profile })).ok, 'joining can be retried')

    console.log('ALL TRANSPORT TIMEOUT REGRESSIONS PASSED')
  } finally {
    transport.disconnect()
    await new Promise<void>((resolve) => io.close(() => resolve()))
    if (http.listening) await new Promise<void>((resolve) => http.close(() => resolve()))
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })

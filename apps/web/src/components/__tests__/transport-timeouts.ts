// A local synthetic Socket.IO peer that intentionally drops acknowledgements.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { SocketTransport } from '../../lib/socketTransport.ts'

async function main() {
  const http = createServer()
  const io = new Server(http, { transports: ['polling', 'websocket'] })
  const state = { code: 'AB2C', phase: 'warmup', hostId: 'p1', players: [{ id: 'p1', alias: 'Guest', connected: true, isBot: false }], round: null, seq: 1 }
  let rejoins = 0, disconnects = 0, dropResumeAck = false, retrySecret = ''
  const submissions: any[] = []
  io.on('connection', (socket) => {
    socket.on('disconnect', () => { disconnects++ })
    socket.on('create', (request, ack) => { if (request.alias !== 'NoAck') ack({ ok: true, code: 'AB2C', you: 'p1', secret: 'secret-1', state }) })
    socket.on('join', (request, ack) => {
      if (request.alias === 'NoAck') return
      rejoins++
      if (dropResumeAck) { dropResumeAck = false; retrySecret = `secret-${rejoins + 1}`; return }
      const nextSecret = retrySecret || `secret-${rejoins + 1}`
      retrySecret = ''
      ack({ ok: true, you: 'p1', secret: nextSecret, state: { ...state, seq: rejoins + 1 } })
    })
    socket.on('submit', (request, ack) => { submissions.push(request); if (request.value.kind === 'dare') ack({ ok: false, error: 'Dare was rejected' }) })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as { port: number }).port
  process.env.NEXT_PUBLIC_SERVER_URL = `http://127.0.0.1:${port}`
  const values = new Map<string, string>()
  ;(globalThis as any).window = { sessionStorage: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) } }
  const doc = new EventTarget() as EventTarget & { visibilityState: string }; doc.visibilityState = 'visible'; (globalThis as any).document = doc
  const transport = new (SocketTransport as any)(100) as SocketTransport
  try {
    assert.ok((await transport.create('Guest', { age: true, terms: true, revealOptIn: false })).ok)
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('submit did not time out')), 700))
    const result = await Promise.race([transport.submit({ roundId: 'r1', clientUuid: 'u1', value: { kind: 'pick', target: 'p2' } }), timeout])
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /timed out|did not answer/i)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(rejoins, 1, 'a lost submit acknowledgement triggers a fresh snapshot')
    dropResumeAck = true
    transport.resume()
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(rejoins, 3, 'a lost resume ack is retried once on the same socket')
    assert.equal(JSON.parse(values.get('reveal.session')!).secret, 'secret-3', 'the recovered rotated token is saved')
    const pass = await transport.darePass({ roundId: 'r1', reason: 'Not tonight' })
    assert.equal(pass.ok, false); assert.match(pass.error ?? '', /rejected/)
    assert.deepEqual(submissions.at(-1).value, { kind: 'dare', status: 'passed', reason: 'Not tonight' })
    assert.ok(submissions.at(-1).clientUuid, 'dare passes get an idempotency key')

    transport.forgetSession()
    const lostCreate = await transport.create('NoAck', { age: true, terms: true, revealOptIn: false })
    assert.equal(lostCreate.ok, false); assert.match(lostCreate.error ?? '', /did not answer/i)
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.ok(disconnects >= 1, 'an unacknowledged create detaches its unknown seat')
    assert.ok((await transport.create('Guest', { age: true, terms: true, revealOptIn: false })).ok, 'creating can be retried')

    transport.forgetSession()
    const lostJoin = await transport.join({ roomCode: 'AB2C', alias: 'NoAck', consent: { age: true, terms: true, revealOptIn: false } })
    assert.equal(lostJoin.ok, false); assert.match(lostJoin.error ?? '', /did not answer/i)
    assert.ok((await transport.join({ roomCode: 'AB2C', alias: 'Guest', consent: { age: true, terms: true, revealOptIn: false } })).ok, 'joining can be retried')
    console.log('ALL TRANSPORT TIMEOUT REGRESSIONS PASSED')
  } finally {
    transport.disconnect(); await new Promise<void>((resolve) => io.close(() => resolve()))
    if (http.listening) await new Promise<void>((resolve) => http.close(() => resolve()))
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })

// Real H1 server + real public-display component, with synthetic players only.
// This verifies the actual Socket.IO stream, not just the adapter fixture.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { io, type Socket } from 'socket.io-client'
import { createGameServer } from '../../../../../apps/server/src/server.ts'
import type { FinaleView, JoinReply, ResponseValue, RevealView, RoundKind, RoundView } from '../../../../../packages/shared/src/contracts.ts'

const kinds: RoundKind[] = ['pick', 'text', 'shout', 'rating', 'ios', 'minigame', 'dare', 'pair_dare', 'debrief', 'spotlight', 'verdict', 'confess']
const timers = Object.fromEntries(kinds.map((kind) => [kind, 200])) as Record<RoundKind, number>
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const limit = <T,>(promise: Promise<T>, ms = 30_000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
  promise.then((value) => { clearTimeout(timer); resolve(value) }, (error) => { clearTimeout(timer); reject(error) })
})

async function main() {
  delete process.env.XAI_API_KEY; delete process.env.GEMINI_API_KEY
  const dir = mkdtempSync(join(tmpdir(), 'display-theatre-integration-'))
  const server = createGameServer({ dataDir: dir, revealMode: 'finale', roundTimers: timers, verdictDiscussMs: 0,
    graceMs: 40, revealHoldMs: 20, interludeHoldMs: 10, readyGraceMs: 25, botDelayMs: [5, 15] })
  let hostSocket: Socket | undefined
  let dom: JSDOM | undefined
  let root: ReturnType<(typeof import('react-dom/client'))['createRoot']> | undefined
  let act: (typeof import('react'))['act'] | undefined
  try {
    const port = await server.listen(0, '127.0.0.1', false)
    const base = `http://127.0.0.1:${port}`
    const host = io(base, { reconnection: false, transports: ['polling', 'websocket'], autoConnect: false })
    hostSocket = host
    host.on('error', () => {})
    const connected = new Promise<void>((resolve) => host.once('connect', resolve)); host.connect(); await limit(connected)
    const made = await limit(new Promise<JoinReply>((resolve) => host.emit('create', {
      alias: 'Host', consent: { age: true, terms: true, revealOptIn: true },
      profile: { age: 28, relationship: 'single', partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: 'vibes' },
    }, resolve)))
    assert.ok(made.ok && made.code && made.you, 'synthetic room created')
    for (let i = 0; i < 3; i++) host.emit('add_bot')
    await delay(50)

    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `${base}/display?code=${made.code}`, pretendToBeVisual: true })
    const w = dom.window as any, g = globalThis as any
    g.window = w; g.document = w.document; g.location = w.location
    Object.defineProperty(g, 'navigator', { value: w.navigator, configurable: true })
    for (const key of ['HTMLElement', 'Element', 'Node', 'SVGElement', 'MouseEvent', 'KeyboardEvent', 'Event', 'getComputedStyle']) g[key] = w[key]
    g.requestAnimationFrame = w.requestAnimationFrame.bind(w); g.cancelAnimationFrame = w.cancelAnimationFrame.bind(w)
    g.IS_REACT_ACT_ENVIRONMENT = true
    w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
    w.scrollTo = () => {}
    let canvasCalls = 0
    w.HTMLCanvasElement.prototype.getContext = () => { canvasCalls++; return null }
    process.env.NEXT_PUBLIC_SERVER_URL = base
    const React = await import('react'); act = React.act
    const { createRoot } = await import('react-dom/client')
    const { default: DisplayPage } = await import('../../app/display/page')
    const element = w.document.createElement('div'); w.document.body.appendChild(element)
    root = createRoot(element)
    await act(async () => { root!.render(React.createElement(DisplayPage)) })
    const waitFor = async (predicate: () => boolean, description: string) => {
      const deadline = Date.now() + 8000
      while (!predicate() && Date.now() < deadline) await act!(async () => { await delay(20) })
      assert.ok(predicate(), `timed out waiting for ${description}`)
    }
    await waitFor(() => (element.textContent ?? '').includes('Connected'), 'real display join')

    const seen = new Set<string>()
    let other = 'p2'
    let phoneReveals = 0
    let displayFinale: FinaleView | undefined
    server.io.on('connection', (socket) => socket.onAnyOutgoing((event, payload) => {
      if (socket.data.display && event === 'finale') displayFinale = payload as FinaleView
    }))
    // The display already joined, so observe its finale on the existing socket.
    for (const socket of server.io.sockets.sockets.values()) if (socket.data.display) {
      socket.onAnyOutgoing((event, payload) => { if (event === 'finale') displayFinale = payload as FinaleView })
    }
    host.on('state', (view) => { other = view.players.find((player: { id: string }) => player.id !== made.you)?.id ?? 'p2' })
    host.on('reveal', () => { phoneReveals++ })
    host.on('round', (round: RoundView) => {
      if (round.youSubmitted || round.expectsAnswer === false || seen.has(round.roundId) || (round.onlyPlayers && !round.onlyPlayers.includes(made.you!))) return
      seen.add(round.roundId)
      const value: ResponseValue = round.kind === 'shout' ? { kind: 'shout', word: 'chaos' }
        : round.kind === 'confess' ? { kind: 'confess', yes: true, note: 'Yes indeed.' }
        : round.kind === 'text' || round.kind === 'spotlight' || round.kind === 'debrief' ? { kind: 'text', text: 'A synthetic answer.' }
        : round.kind === 'rating' ? { kind: 'rating', trait: round.trait!, about: round.about!, value: 6 }
        : round.kind === 'ios' ? { kind: 'ios', about: round.about!, value: 5 }
        : round.kind === 'minigame' ? { kind: 'minigame', score: 12 }
        : round.kind === 'dare' || round.kind === 'pair_dare' ? { kind: 'dare', status: 'done' }
        : { kind: 'pick', target: other }
      host.emit('submit', { roundId: round.roundId, clientUuid: `display-test:${round.roundId}`, value }, () => {})
    })
    const phoneFinalePromise = new Promise<FinaleView>((resolve) => host.once('finale', resolve))
    let phoneFinale!: FinaleView
    await act(async () => { host.emit('start'); phoneFinale = await limit(phoneFinalePromise); await delay(100) })
    await waitFor(() => Boolean(element.querySelector('[data-testid="finale-theatre"]')), 'host-paced finale theatre')
    assert.equal(phoneReveals, 0, 'phones do not receive the display-only reel')
    assert.deepEqual(displayFinale, phoneFinale, 'the public finale is identical on display and phone')
    const name = readdirSync(dir).find((file) => file.endsWith('.reveals.log'))
    assert.ok(name, 'H1 persisted a real queue')
    const queue = readFileSync(join(dir, name), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { roundId: string; reveal: RevealView })
    assert.ok(queue.length >= 10, 'a complete synthetic night produced reveals')

    const stage = () => element.querySelector('[data-testid="finale-theatre"]')
    const next = () => [...element.querySelectorAll('button')].find((button: any) => /^next\b/i.test(button.textContent?.trim() ?? '')) as Element | undefined
    const click = async () => { const button = next(); assert.ok(button); await act!(async () => { button.dispatchEvent(new w.MouseEvent('click', { bubbles: true })) }) }
    for (let index = 0; index < queue.length; index++) {
      assert.equal(stage()?.getAttribute('data-round-id'), queue[index]!.roundId, `queued reveal ${index + 1} is in order`)
      assert.equal(stage()?.querySelector('h2')?.textContent, queue[index]!.reveal.summary)
      assert.match(stage()?.textContent ?? '', new RegExp(`Reveal ${index + 1} / ${queue.length}`))
      if (index === 1) {
        const old = [...server.io.sockets.sockets.values()].find((socket) => socket.data.display)
        assert.ok(old)
        await act(async () => { old.conn.close(); await delay(20) })
        await waitFor(() => [...server.io.sockets.sockets.values()].some((socket) => socket.data.display && socket !== old) && (element.textContent ?? '').includes('Connected'), 'real display reconnect and queue replay')
        await act(async () => { await delay(100) })
        assert.equal(stage()?.getAttribute('data-round-id'), queue[index]!.roundId, 'real replay preserves host progress')
      }
      await click()
    }
    assert.equal(stage(), null)
    const slideTitles = [...element.querySelectorAll('section article h2')].map((node: any) => node.textContent)
    assert.deepEqual(slideTitles, phoneFinale.slides.map((slide) => slide.title), 'the final advance hands off to the unchanged finale')
    assert.equal(canvasCalls, 0, 'the public stage never starts confetti')
    console.log(`REAL H1 DISPLAY INTEGRATION PASSED: ${queue.length} ordered reveals, reconnect, finale equality`)
  } finally {
    if (root && act) await act(async () => root!.unmount())
    dom?.window.close()
    hostSocket?.disconnect()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })

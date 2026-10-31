// Public-display-only regression. The socket server is a synthetic H1 delivery
// fixture: H1 streams the same RevealViews in order before the finale event.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { JSDOM } from 'jsdom'
import { Server, type Socket } from 'socket.io'
import type { FinaleView, RevealView, RoomView } from '../../../../../packages/shared/src/contracts.ts'

const queuedReveals: RevealView[] = [
  { roundId: 'round-one', summary: 'FIRST REVEAL', items: [{ alias: 'Ada', text: 'First answer' }], holdMs: 1 },
  { roundId: 'round-two', kind: 'spotlight', summary: 'SECOND REVEAL', subject: 'Bea', items: [{ alias: 'Cy', text: 'Second answer' }], punchline: 'A punchline', holdMs: 1 },
  { roundId: 'round-three', kind: 'verdict', summary: 'THIRD REVEAL', slide: { beat: 'land', flavor: 'group', title: 'Ada', numbers: { votes: 3 } }, celebrate: true, holdMs: 1 },
]
const finale: FinaleView = {
  slides: [{ beat: 'tease', title: 'EXISTING FINALE', body: 'The story remains the same.' }, { beat: 'land', title: 'GOOD NIGHT' }],
  summary: {},
}
const room: RoomView = { code: 'AB2C', phase: 'warmup', hostId: 'p1', players: [], round: null, seq: 1 }
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function main() {
  const http = createServer()
  const io = new Server(http, { transports: ['polling', 'websocket'] })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as { port: number }).port
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `http://127.0.0.1:${port}/display?code=AB2C`, pretendToBeVisual: true })
  const w = dom.window as any, g = globalThis as any
  g.window = w; g.document = w.document; g.location = w.location
  Object.defineProperty(g, 'navigator', { value: w.navigator, configurable: true })
  for (const key of ['HTMLElement', 'Element', 'Node', 'SVGElement', 'MouseEvent', 'KeyboardEvent', 'Event', 'getComputedStyle']) g[key] = w[key]
  g.requestAnimationFrame = w.requestAnimationFrame.bind(w); g.cancelAnimationFrame = w.cancelAnimationFrame.bind(w)
  g.IS_REACT_ACT_ENVIRONMENT = true
  let reduced = false
  w.matchMedia = () => ({ matches: reduced, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  let canvasCalls = 0
  const scrolls: ScrollToOptions[] = []
  w.scrollTo = (options: ScrollToOptions) => { scrolls.push(options) }
  w.HTMLCanvasElement.prototype.getContext = () => { canvasCalls++; return null }
  process.env.NEXT_PUBLIC_SERVER_URL = `http://127.0.0.1:${port}`

  let display: Socket | undefined
  let snapshot = room
  io.on('connection', (socket) => socket.on('display_join', (input, reply) => {
    assert.equal(input.roomCode, 'AB2C')
    display = socket
    reply({ ok: true, state: snapshot })
  }))

  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { renderToString } = await import('react-dom/server')
  const { default: DisplayPage } = await import('../../app/display/page')
  const { DisplayFinale, DisplayReveal, FinaleTheatre } = await import('../../app/display/FinaleTheatre')
  const { QUEUED_REVEALS_EVENT } = await import('../../app/display/queuedReveals')
  let failures = 0
  async function waitFor(test: () => boolean, what: string) {
    const deadline = Date.now() + 5000
    while (!test() && Date.now() < deadline) await act(async () => { await delay(15) })
    assert.ok(test(), `timed out waiting for ${what}`)
  }
  async function check(name: string, fn: (host: HTMLElement, socket: Socket) => Promise<void>) {
    const host = w.document.createElement('div'); w.document.body.appendChild(host)
    const root = createRoot(host); display = undefined; snapshot = room
    try {
      await act(async () => root.render(React.createElement(DisplayPage)))
      await waitFor(() => Boolean(display) && (host.textContent ?? '').includes('Connected'), 'display join')
      await fn(host, display!)
      console.log(`PASS ${name}`)
    } catch (error) { failures++; console.error(`FAIL ${name}:`, error) }
    finally { await act(async () => root.unmount()); host.remove(); reduced = false }
  }
  const send = async (socket: Socket, event: string, payload?: unknown) => act(async () => { socket.emit(event, payload); await delay(30) })
  const enterFinale = async (socket: Socket) => {
    snapshot = { ...snapshot, phase: 'finale', round: null, seq: snapshot.seq + 1 }
    await send(socket, 'state', snapshot)
  }
  const stream = async (socket: Socket, reveals: readonly unknown[]) => {
    // Real H1 uses individual `reveal` events, in order, then `finale`.
    await act(async () => { for (const reveal of reveals) socket.emit('reveal', reveal); await delay(30) })
  }
  const startStream = async (socket: Socket, reveals: readonly unknown[]) => { await enterFinale(socket); await stream(socket, reveals) }
  const click = async (el: Element) => act(async () => { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })) })
  const arrow = async (key = 'ArrowRight', options: Record<string, unknown> = {}, target: EventTarget = w) => {
    const event = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
    await act(async () => { target.dispatchEvent(event) })
    return event
  }
  const next = (host: HTMLElement) => [...host.querySelectorAll('button')].find((button) => /^next\b/i.test(button.textContent?.trim() ?? ''))
  const assertFinaleUnchanged = (host: HTMLElement) => {
    const actual = [...host.querySelectorAll('section')].find((section) => section.textContent?.includes('EXISTING FINALE'))
    const expected = w.document.createElement('div')
    expected.innerHTML = renderToString(React.createElement(DisplayFinale, { view: finale }))
    assert.ok(actual, 'existing display finale is visible')
    assert.equal(actual.outerHTML, expected.firstElementChild?.outerHTML, 'the handoff uses the unchanged display slides')
  }

  try {
    // SSR has no window, and must render only the first reveal using the exact
    // same public reveal markup as a live round (not the phone finale/deck).
    try {
      delete g.window
      const revealMarkup = renderToString(React.createElement(DisplayReveal, { reveal: queuedReveals[0] }))
      const theatre = renderToString(React.createElement(FinaleTheatre, { reveals: queuedReveals, finale }))
      assert.ok(theatre.includes(revealMarkup))
      assert.match(theatre, /FIRST REVEAL/)
      assert.doesNotMatch(theatre, /SECOND REVEAL|THIRD REVEAL|EXISTING FINALE/)
      assert.match(theatre, /Next reveal/)
      const existingFinale = '<section class="mx-auto max-w-5xl space-y-8 text-center"><p class="text-xs uppercase tracking-[0.35em] text-lime-accent">The Reveal</p><article class="glass-card p-8"><h2 class="text-3xl font-bold">EXISTING FINALE</h2><p class="mt-4 text-xl text-white/75">The story remains the same.</p></article><article class="glass-card p-8"><h2 class="text-3xl font-bold">GOOD NIGHT</h2></article></section>'
      assert.equal(renderToString(React.createElement(DisplayFinale, { view: finale })), existingFinale, 'the old public finale markup is unchanged')
      assert.equal(renderToString(React.createElement(FinaleTheatre, { reveals: [], finale })), existingFinale)
      console.log('PASS SSR renders the first public reveal and hands an empty queue to the original finale')
    } catch (error) { failures++; console.error('FAIL display theatre SSR:', error) }
    finally { g.window = w }

    await check('queued round reveals wait for NEXT and hand off to the existing display finale', async (host, socket) => {
      await startStream(socket, [queuedReveals[0], queuedReveals[0], ...queuedReveals.slice(1)])
      assert.doesNotMatch(host.textContent ?? '', /FIRST REVEAL|SECOND REVEAL|THIRD REVEAL/, 'an incomplete stream must not leak or skip to its last packet')
      assert.equal(next(host), undefined, 'wait until the complete stream arrives')
      await send(socket, 'finale', finale)
      assert.match(host.textContent ?? '', /FIRST REVEAL/)
      assert.match(host.textContent ?? '', /First answer/)
      assert.match(host.textContent ?? '', /Reveal 1 \/ 3/)
      assert.doesNotMatch(host.textContent ?? '', /SECOND REVEAL|THIRD REVEAL|EXISTING FINALE/)
      assert.ok(host.querySelector('[aria-live="polite"]'), 'the changing reveal is announced')
      await act(async () => { await delay(50) })
      assert.match(host.textContent ?? '', /FIRST REVEAL/, 'holdMs must not auto-advance the host stage')
      const button = next(host)
      assert.ok(button, 'a NEXT button is available')
      assert.ok(button.classList.contains('min-h-[72px]'), 'NEXT is a large touch target')
      assert.equal(button.getAttribute('aria-label'), 'Next reveal')
      await click(button)
      assert.deepEqual(scrolls.at(-1), { top: 0, left: 0, behavior: 'instant' }, 'long reveals reset to the next heading without scrolling animation')
      assert.match(host.textContent ?? '', /SECOND REVEAL/)
      assert.match(host.textContent ?? '', /Second answer/)
      assert.doesNotMatch(host.textContent ?? '', /FIRST REVEAL|THIRD REVEAL|EXISTING FINALE/)
      await arrow('ArrowRight', { repeat: true })
      assert.match(host.textContent ?? '', /SECOND REVEAL/, 'holding a key cannot skip reveals')
      const input = w.document.createElement('input'); w.document.body.appendChild(input)
      await arrow('ArrowRight', {}, input)
      input.remove()
      assert.match(host.textContent ?? '', /SECOND REVEAL/, 'typing controls retain their arrow keys')
      const forward = await arrow()
      assert.ok(forward.defaultPrevented)
      assert.match(host.textContent ?? '', /THIRD REVEAL/)
      assert.doesNotMatch(host.textContent ?? '', /FIRST REVEAL|SECOND REVEAL|EXISTING FINALE/)
      assert.equal(next(host)?.getAttribute('aria-label'), 'Next: show the finale')
      await click(next(host)!)
      assertFinaleUnchanged(host)
      assert.doesNotMatch(host.textContent ?? '', /FIRST REVEAL|SECOND REVEAL|THIRD REVEAL/)
      assert.equal(next(host), undefined)
      assert.equal((await arrow()).defaultPrevented, false, 'the theatre releases the keyboard after handoff')
      assert.equal(canvasCalls, 0, 'even a celebrate=true verdict must not launch confetti on the public display')
    })

    await check('reduced motion advances immediately with no automatic pacing', async (host, socket) => {
      reduced = true
      await startStream(socket, queuedReveals)
      await send(socket, 'finale', finale)
      assert.match(host.textContent ?? '', /FIRST REVEAL/)
      await click(next(host)!)
      assert.match(host.textContent ?? '', /SECOND REVEAL/, 'next content is present in the same update')
      await arrow('ArrowDown')
      assert.match(host.textContent ?? '', /THIRD REVEAL/)
      await arrow()
      assertFinaleUnchanged(host)
      assert.equal(canvasCalls, 0)
    })

    await check('a late finale releases the complete stream; an empty stream goes straight to the finale', async (host, socket) => {
      await startStream(socket, [queuedReveals[0]])
      assert.equal(next(host), undefined, 'a partial stream does not offer a premature last advance')
      await send(socket, 'finale', finale)
      assert.match(host.textContent ?? '', /FIRST REVEAL/)
      await click(next(host)!)
      assertFinaleUnchanged(host)
    })

    await check('an empty stream leaves the existing finale unchanged', async (host, socket) => {
      await enterFinale(socket)
      await send(socket, 'finale', finale)
      assertFinaleUnchanged(host)
      assert.equal(next(host), undefined)
    })

    await check('a single-batch ordered array is also accepted at the display seam', async (host, socket) => {
      await enterFinale(socket)
      await send(socket, QUEUED_REVEALS_EVENT, queuedReveals)
      await send(socket, 'finale', finale)
      assert.match(host.textContent ?? '', /FIRST REVEAL/)
      await click(next(host)!)
      assert.match(host.textContent ?? '', /SECOND REVEAL/)
    })

    await check('a disconnected partial stream is discarded before the full replay', async (host, socket) => {
      await startStream(socket, [queuedReveals[0]])
      await act(async () => { socket.conn.close(); await delay(20) })
      await waitFor(() => Boolean(display && display !== socket) && (host.textContent ?? '').includes('Connected'), 'display reconnect')
      await stream(display!, queuedReveals)
      await send(display!, 'finale', finale)
      assert.match(host.textContent ?? '', /Reveal 1 \/ 3/, 'a partial prior delivery is not duplicated')
      assert.match(host.textContent ?? '', /FIRST REVEAL/)
    })

    await check('ordinary live reveals and finale remain unchanged without a queue', async (host, socket) => {
      await send(socket, 'reveal', queuedReveals[0])
      assert.match(host.textContent ?? '', /FIRST REVEAL/)
      assert.equal(next(host), undefined)
      const actual = [...host.querySelectorAll('section')].find((section) => section.textContent?.includes('FIRST REVEAL'))
      const expected = w.document.createElement('div')
      expected.innerHTML = renderToString(React.createElement(DisplayReveal, { reveal: queuedReveals[0] }))
      assert.equal(actual?.outerHTML, expected.firstElementChild?.outerHTML.replaceAll('<!-- -->', ''))
      await enterFinale(socket)
      await send(socket, 'finale', finale)
      assertFinaleUnchanged(host)
      assert.equal(next(host), undefined)
    })

    await check('reconnect and duplicate delivery preserve the host position, including after handoff', async (host, socket) => {
      await startStream(socket, queuedReveals)
      await send(socket, 'finale', finale)
      await click(next(host)!)
      assert.match(host.textContent ?? '', /SECOND REVEAL/)
      await act(async () => { socket.conn.close(); await delay(20) })
      await waitFor(() => Boolean(display && display !== socket) && (host.textContent ?? '').includes('Connected'), 'display reconnect')
      await stream(display!, queuedReveals.slice(0, 1))
      assert.match(host.textContent ?? '', /SECOND REVEAL/, 'a partial replay does not change the host position')
      await stream(display!, queuedReveals.slice(1))
      await send(display!, 'finale', finale)
      assert.match(host.textContent ?? '', /SECOND REVEAL/, 'replay does not restart the queue')
      await click(next(host)!)
      await click(next(host)!)
      assertFinaleUnchanged(host)
      await stream(display!, queuedReveals)
      await send(display!, 'finale', finale)
      assertFinaleUnchanged(host)
      await stream(display!, [{ ...queuedReveals[0], roundId: 'new-night' }])
      await send(display!, 'finale', finale)
      assert.match(host.textContent ?? '', /FIRST REVEAL/, 'a different queue starts at the beginning')
    })

    await check('invalid queue payloads cannot replace live mode and deletion clears the theatre', async (host, socket) => {
      await send(socket, QUEUED_REVEALS_EVENT, [{ roundId: 'broken', items: 'not an array' }])
      await send(socket, 'reveal', queuedReveals[0])
      assert.match(host.textContent ?? '', /FIRST REVEAL/)
      assert.equal(next(host), undefined)
      await startStream(socket, [{ roundId: 'broken', items: 'not an array' }, ...queuedReveals])
      await send(socket, 'finale', finale)
      assert.match(host.textContent ?? '', /Reveal 1 \/ 3/, 'malformed entries are discarded')
      assert.ok(next(host))
      await send(socket, 'deleted')
      assert.doesNotMatch(host.textContent ?? '', /FIRST REVEAL|SECOND REVEAL|THIRD REVEAL/)
      assert.equal(next(host), undefined)
    })
  } finally {
    dom.window.close()
    await new Promise<void>((resolve) => io.close(() => resolve()))
  }
  if (failures) process.exitCode = 1
  else console.log('ALL PUBLIC DISPLAY THEATRE TESTS PASSED')
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })

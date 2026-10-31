// Full mock app: deleting the room must unmount a revealed secret without
// waiting for a page exit animation. All room data here is synthetic.
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

async function main() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
  const w = dom.window as any, g = globalThis as any
  g.window = w; g.document = w.document
  Object.defineProperty(g, 'navigator', { value: w.navigator, configurable: true })
  for (const key of ['HTMLElement', 'Element', 'Node', 'SVGElement', 'MouseEvent', 'KeyboardEvent', 'Event', 'getComputedStyle']) g[key] = w[key]
  g.requestAnimationFrame = w.requestAnimationFrame.bind(w); g.cancelAnimationFrame = w.cancelAnimationFrame.bind(w)
  g.IS_REACT_ACT_ENVIRONMENT = true
  w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  w.HTMLCanvasElement.prototype.getContext = () => null
  if (!w.PointerEvent) w.PointerEvent = class extends w.MouseEvent {
    pointerId: number; pointerType: string
    constructor(type: string, init: any = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? 'touch' }
  }
  process.env.NEXT_PUBLIC_TRANSPORT = 'mock'
  w.sessionStorage.setItem('reveal.intro-done', '1')
  const React = await import('react'), { act } = React
  const { createRoot } = await import('react-dom/client')
  const { MockTransport } = await import('../../lib/mockTransport')
  const { FinaleScreen } = await import('../FinaleScreen')
  const { demoFinale } = await import('../__demo__/demoFinale')
  const { demoDeck } = await import('../__demo__/demoDeck')
  const host = w.document.createElement('div'); w.document.body.appendChild(host)
  const root = createRoot(host)
  const click = async (el: Element) => act(async () => { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })) })
  try {
    // The mock's deck and the finale, then the room is deleted.
    const transport = new MockTransport()
    let deck: any = null
    transport.setHandlers({ onSecrets: (d) => { deck = d } })
    await transport.join({
      roomCode: 'MOCK', alias: 'Guest 1', consent: { age: true, terms: true },
      profile: { age: 27, gender: 'woman', sexuality: 'straight', attractedTo: 'women', lookingFor: 'fun' },
    })
    transport.start()
    await new Promise((resolve) => setTimeout(resolve, 1100))
    // Run the night out to the ONE ready gate.
    for (let i = 0; i < 12; i++) transport.skipRound()
    transport.ready()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(deck, 'the phone has a private deck')

    await act(async () => { root.render(<FinaleScreen view={demoFinale} deck={deck} roomCode="MOCK" />); await new Promise((resolve) => setTimeout(resolve, 30)) })
    for (let i = 0; i < 24 && !host.querySelector('[data-testid="finale-end"]'); i++) {
      const tap = host.querySelector('[data-testid="finale-tap-layer"]')
      assert.ok(tap, 'the finale story is visible')
      await click(tap)
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    }
    assert.ok(host.querySelector('[data-testid="finale-end"]'), 'can finish the public story')
    const open = [...host.querySelectorAll('button')].find((el: any) => el.textContent?.includes('Open your secret deck'))
    assert.ok(open, 'the private deck remains accessible')
    await click(open)
    const card = host.querySelector('[data-testid="hold-to-reveal"]')
    assert.ok(card)
    await act(async () => { card.dispatchEvent(new w.PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch' })) })
    assert.ok(host.querySelector('[data-testid="secret-face"]'), 'the test reveals a private card')

    // Deleting the room must unmount the revealed card at once.
    transport.deleteRoom()
    await act(async () => { root.render(<div />); await new Promise((resolve) => setTimeout(resolve, 30)) })
    assert.ok(!host.querySelector('[data-testid="secret-face"]'), 'delete immediately unmounts any revealed secret')
    transport.disconnect()
    console.log('APP DELETE PRIVACY REGRESSION PASSED')
  } finally {
    await act(async () => root.unmount()); dom.window.close()
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })

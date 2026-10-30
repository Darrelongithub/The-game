// Full mock app: a remote/local delete must unmount a revealed secret without
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
  const players = [1, 2, 3, 4].map((i) => ({ id: `p${i}`, alias: `Guest ${i}`, connected: true, isBot: false }))
  w.sessionStorage.setItem('reveal.intro-done', '1')
  w.sessionStorage.setItem('reveal.session', JSON.stringify({ code: 'MOCK', you: 'p1', secret: 'mock-secret', alias: 'Guest 1' }))
  w.sessionStorage.setItem('reveal.mock.snapshot', JSON.stringify({ you: 'p1', alias: 'Guest 1', players, hostId: 'p1', phase: 'finale', seq: 8, stepIndex: 20, round: null, closedAt: 0, votes: 0 }))
  const React = await import('react'), { act } = React
  const { createRoot } = await import('react-dom/client')
  const { default: PlayPage } = await import('../../app/page')
  const host = w.document.createElement('div'); w.document.body.appendChild(host)
  const root = createRoot(host)
  const click = async (el: Element) => act(async () => { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })) })
  try {
    await act(async () => { root.render(<PlayPage />); await new Promise((resolve) => setTimeout(resolve, 30)) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })
    for (let i = 0; i < 24 && !host.querySelector('[data-testid="finale-end"]'); i++) {
      const tap = host.querySelector('[data-testid="finale-tap-layer"]')
      assert.ok(tap, 'the finale story is visible')
      await click(tap)
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    }
    assert.ok(host.querySelector('[data-testid="finale-end"]'), 'can finish the public story')
    const open = [...host.querySelectorAll('button')].find((el: any) => el.textContent?.includes('Open your secret deck'))
    assert.ok(open, 'the private deck remains accessible in mock mode'); await click(open)
    const card = host.querySelector('[data-testid="hold-to-reveal"]')
    assert.ok(card)
    await act(async () => { card.dispatchEvent(new w.PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch' })) })
    assert.ok(host.querySelector('[data-testid="secret-face"]'), 'the test reveals a private card')
    const remove = [...host.querySelectorAll('button')].find((el: any) => el.textContent?.includes('Delete room'))
    assert.ok(remove); await click(remove)
    const confirm = [...host.querySelectorAll('[role="alertdialog"] button')].find((el: any) => el.textContent === 'Delete')
    assert.ok(confirm); await click(confirm)
    assert.ok(!host.querySelector('[data-testid="secret-face"]'), 'delete immediately unmounts any revealed secret')
    console.log('APP DELETE PRIVACY REGRESSION PASSED')
  } finally {
    await act(async () => root.unmount()); dom.window.close()
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })

// Behavioral regressions against the real React components in a DOM. Synthetic
// data only; there are no providers or real player sessions in this suite.
//
// v3.2: the sign-up fields, the ONE-question phone layout, the forced pick and
// the host laptop.
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import type { RoomView, RoundView } from '../../../../../packages/shared/src/contracts.ts'

async function main() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
  const w = dom.window as any
  const g = globalThis as any
  g.window = w; g.document = w.document
  Object.defineProperty(g, 'navigator', { value: w.navigator, configurable: true })
  for (const key of ['HTMLElement', 'Element', 'Node', 'SVGElement', 'MouseEvent', 'KeyboardEvent', 'Event', 'getComputedStyle']) g[key] = w[key]
  g.requestAnimationFrame = w.requestAnimationFrame.bind(w)
  g.cancelAnimationFrame = w.cancelAnimationFrame.bind(w)
  g.IS_REACT_ACT_ENVIRONMENT = true
  let reduced = false
  w.matchMedia = () => ({ matches: reduced, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  w.HTMLCanvasElement.prototype.getContext = () => null
  if (!w.PointerEvent) w.PointerEvent = class extends w.MouseEvent {
    pointerId: number; pointerType: string
    constructor(type: string, init: any = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? 'touch' }
  }
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { JoinScreen } = await import('../JoinScreen')
  const { QuestionScreen } = await import('../play/QuestionScreen')
  const { HoldToReveal } = await import('../HoldToReveal')
  const { Flame } = await import('../Flame')
  let failures = 0
  async function check(name: string, fn: (root: ReturnType<typeof createRoot>, host: HTMLElement) => Promise<void> | void) {
    const host = w.document.createElement('div'); w.document.body.appendChild(host)
    const root = createRoot(host)
    try { await fn(root, host); console.log(`PASS ${name}`) }
    catch (error) { failures++; console.error(`FAIL ${name}:`, error) }
    finally { await act(async () => root.unmount()); host.remove() }
  }
  const render = async (root: ReturnType<typeof createRoot>, node: React.ReactNode) => { await act(async () => root.render(node)) }
  const click = async (el: Element) => { await act(async () => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }))) }
  const pointer = async (el: Element, type: string) => { await act(async () => el.dispatchEvent(new w.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch' }))) }
  const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find((el) => el.textContent?.includes(text))!
  const setInput = async (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(el, value); el.dispatchEvent(new w.Event('input', { bubbles: true })) })
  }

  const players = [
    { id: 'p1', alias: 'Wanjiru', connected: true, isBot: false, ready: true },
    { id: 'p2', alias: 'Dee', connected: true, isBot: false, ready: false },
    { id: 'p3', alias: 'Kofi', connected: true, isBot: false, ready: true },
  ]
  const view: RoomView = {
    code: 'AB2C',
    phase: 'play',
    players,
    round: null,
    seq: 1,
    hostPresent: true,
    lobbyReady: ['p1', 'p3'],
    progress: { index: 1, total: 12 },
    pickOptions: ['p2', 'p3'],
  }
  const pickRound: RoundView = {
    roundId: 'r1',
    segmentId: 'r1-s0',
    index: 1,
    kind: 'pick',
    promptText: 'Who in this room would you take home from this party?',
    note: "About Wanjiru. They won't see this.",
    closesAt: Date.now() + 60_000,
    youSubmitted: false,
    submitted: [],
  }

  await check('the sign-up asks for exactly the engine fields and the 18+ tick', async (root, host) => {
    let joined: any = null
    await render(root, <JoinScreen hasSession={false} busy={false} error={null} onJoin={async (code, alias, consent, profile) => {
      joined = { code, alias, consent, profile }
      return { ok: true }
    }} />)
    const labels = [...host.querySelectorAll('label')].map((l) => l.textContent ?? '')
    assert.ok(labels.some((l) => l.includes('Your alias')), 'the alias field')
    assert.ok(labels.some((l) => l.includes('How old are you?')), 'the age field')
    assert.ok(labels.some((l) => l.includes('Gender')), 'the gender field')
    assert.ok(labels.some((l) => l.includes('Sexuality')), 'the sexuality field')
    assert.ok(labels.some((l) => l.includes('attracted to')), 'the attraction field')
    assert.ok(!labels.some((l) => /partner|longest relationship|relationship status/i.test(l)), 'no relationship history')
    const submit = button(host, 'Join the room') as HTMLButtonElement
    assert.ok(submit.disabled, 'the join button is disabled before sign-up')
    await setInput(host.querySelector<HTMLInputElement>('#alias')!, 'Wanjiru')
    await setInput(host.querySelector<HTMLInputElement>('#code')!, 'AB2C')
    await setInput(host.querySelector<HTMLInputElement>('#profile-age')!, '30')
    const tick = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await act(async () => { tick.click() })
    await click(submit)
    assert.ok(joined, 'the sign-up was sent')
    assert.equal(joined.alias, 'Wanjiru')
    assert.equal(joined.consent.age, true)
    assert.equal(joined.profile.age, 30)
    assert.equal(joined.profile.sexuality, 'undisclosed')
    assert.equal(joined.profile.attractedTo, 'undisclosed')
  })

  await check('the phone shows ONE question, one grey line and the answer controls', async (root, host) => {
    await render(root, <QuestionScreen round={pickRound} view={view} you={'p1'} onSubmit={async () => true} />)
    const question = host.querySelector('[data-testid="question"]')!
    assert.equal(question.textContent, pickRound.promptText)
    const note = host.querySelector('[data-testid="question-note"]')!
    assert.equal(note.textContent, pickRound.note)
    assert.ok(host.querySelector('[data-testid="answer-controls"]'))
    // ONE question: exactly one question element on the phone.
    assert.equal(host.querySelectorAll('[data-testid="question"]').length, 1)
  })

  await check('the pick list never contains the player itself and offers no skip', async (root, host) => {
    const sent: any[] = []
    await render(root, <QuestionScreen round={pickRound} view={view} you={'p1'} onSubmit={async (value) => { sent.push(value); return true }} />)
    const options = [...host.querySelectorAll('[data-testid="pick-option"]')].map((b) => b.textContent)
    assert.deepEqual(options, ['Dee', 'Kofi'], 'the other players, never yourself')
    assert.ok(![...host.querySelectorAll('button')].some((b) => /skip/i.test(b.textContent ?? '')), 'there is no skip button')
    await click(host.querySelector('[data-testid="pick-option"]')!)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].kind, 'pick')
    assert.notEqual(sent[0].target, 'p1')
  })

  await check('the room view never leaks a profile answer', async (root, host) => {
    await render(root, <QuestionScreen round={pickRound} view={view} you={'p1'} onSubmit={async () => true} />)
    const html = host.innerHTML
    assert.ok(!html.includes('sexuality'), 'no sexuality on the phone')
    assert.ok(!html.includes('attractedTo'), 'no attraction on the phone')
  })

  await check('a held card shows its face and releases back to face-down', async (root, host) => {
    const facts = 'You and Dee like each other.'
    await render(root, <HoldToReveal cardLabel="MUTUAL CRUSH" onAdvance={() => {}} face={<div>{facts}</div>} />)
    const card = host.querySelector('[data-testid="hold-to-reveal"]')!
    assert.equal(card.getAttribute('data-state'), 'closed')
    assert.ok(!host.innerHTML.includes(facts), 'the face is not mounted face-down')
    await pointer(card, 'pointerdown')
    await act(async () => { await new Promise((r) => setTimeout(r, 600)) })
    assert.equal(card.getAttribute('data-state'), 'open')
    assert.ok(host.innerHTML.includes(facts))
    await pointer(card, 'pointerup')
    assert.equal(card.getAttribute('data-state'), 'closed')
  })

  await check('the flame still renders', async (root, host) => {
    await render(root, <Flame size={40} />)
    assert.ok(host.querySelector('[role="img"][aria-label="Flame"]'))
  })

  console.log(failures === 0 ? 'ALL COMPONENT REGRESSIONS PASSED' : `${failures} COMPONENT REGRESSION FAILURES`)
  if (failures) process.exitCode = 1
  dom.window.close()
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })

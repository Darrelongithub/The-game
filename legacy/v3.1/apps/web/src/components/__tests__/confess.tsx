// __tests__/confess.tsx — CONFESS ROUNDS on the phone.
//
// Renders the REAL PromptScreen and RevealScreen in jsdom:
//   * a confess round asks yes/no about YOURSELF, offers no skip, and submits
//     { kind: "confess", yes, target?, note? } — nothing else;
//   * the warm reveal shows counts only and never a name;
//   * the spicy reveal names the yeses and never the noes.
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import type { RoomView, RoundView } from '../../../../../packages/shared/src/contracts.ts'

async function main() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
  const w = dom.window as any
  const g = globalThis as any
  g.window = w; g.document = w.document
  Object.defineProperty(g, 'navigator', { value: w.navigator, configurable: true })
  for (const key of ['HTMLElement', 'Element', 'Node', 'SVGElement', 'MouseEvent', 'KeyboardEvent', 'Event', 'getComputedStyle', 'HTMLCanvasElement', 'localStorage']) {
    if (w[key] !== undefined) g[key] = w[key]
  }
  g.requestAnimationFrame = w.requestAnimationFrame.bind(w)
  g.cancelAnimationFrame = w.cancelAnimationFrame.bind(w)
  g.IS_REACT_ACT_ENVIRONMENT = true
  w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  w.HTMLCanvasElement.prototype.getContext = () => null
  w.scrollTo = () => {}

  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { PromptScreen } = await import('../../screens/PromptScreen')
  const { RevealScreen } = await import('../../screens/RevealScreen')

  let failures = 0
  const check = async (name: string, fn: (host: HTMLElement, root: ReturnType<typeof createRoot>) => Promise<void> | void) => {
    const host = w.document.createElement('div'); w.document.body.appendChild(host)
    const root = createRoot(host)
    try { await fn(host, root); console.log(`PASS ${name}`) }
    catch (error) { failures++; console.error(`FAIL ${name}:`, error) }
    finally { await act(async () => root.unmount()); host.remove() }
  }
  const render = async (root: ReturnType<typeof createRoot>, node: React.ReactNode) => { await act(async () => root.render(node)) }
  const click = async (el: Element) => { await act(async () => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }))) }
  const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')?.set
    const proto = el.tagName === 'TEXTAREA' ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype
    const textSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set ?? setter
    await act(async () => { textSetter?.call(el, value); el.dispatchEvent(new w.Event('input', { bubbles: true })) })
  }
  const buttonByText = (host: HTMLElement, pattern: RegExp): HTMLElement | undefined =>
    [...host.querySelectorAll('button')].find((button) => pattern.test(button.textContent ?? '')) as HTMLElement | undefined

  const players = [
    { id: 'p1', alias: 'Alice', connected: true, isHost: true, isBot: false },
    { id: 'p2', alias: 'Brian', connected: true, isHost: false, isBot: false },
    { id: 'p3', alias: 'Chao', connected: true, isHost: false, isBot: false },
  ] as unknown as RoomView['players']
  const room = { code: 'ROOM', hostId: 'p1', phase: 'spicy', players, round: null, seq: 1 } as unknown as RoomView
  const confessRound = {
    roundId: 'r-confess', index: 7, kind: 'confess', phase: 'spicy',
    promptText: 'Have you ever sent a nude to someone in this room?',
    promptId: 'sc1', closesAt: Date.now() + 20_000, expectsAnswer: true,
    youSubmitted: false,
  } as unknown as RoundView

  /* ── 1. the answer sheet: yes / no, no skip, optional target + note ──── */
  await check('a confess round answers about yourself and offers no skip', async (host, root) => {
    let submitted: unknown
    await render(root, React.createElement(PromptScreen, {
      round: confessRound, room, you: 'p1',
      onSubmit: (value: unknown) => { submitted = value; return true },
    }))
    const sheet = host.querySelector('[data-testid="confess-answer"]')
    assert.ok(sheet, 'the confess answer sheet renders')
    assert.ok(buttonByText(host, /^Yes$/u), 'a Yes button')
    assert.ok(buttonByText(host, /^No$/u), 'a No button')
    assert.equal(buttonByText(host, /skip|pass|can't/iu), undefined, 'there is no skip option')
    // The submit button exists but does nothing until yes/no is chosen.
    const lock = buttonByText(host, /lock in answer/iu) as HTMLButtonElement
    assert.ok(lock)
    assert.equal(lock.disabled, true, 'nothing to send before a yes or a no')
    // The optional target list is hidden until the answer is YES.
    assert.equal([...host.querySelectorAll('button')].filter((b) => /Brian|Chao/u.test(b.textContent ?? '')).length, 0)
    await click(buttonByText(host, /^Yes$/u)!)
    assert.ok(buttonByText(host, /Brian/u), 'a yes may point at someone')
    await click(buttonByText(host, /Brian/u)!)
    const note = host.querySelector('#confess-note') as HTMLInputElement
    assert.ok(note, 'a one-line note field')
    await type(note, 'Only once.')
    await click(buttonByText(host, /lock in answer/iu)!)
    assert.deepEqual(submitted, { kind: 'confess', yes: true, target: 'p2', note: 'Only once.' })
  })

  /* ── 2. "no" never takes a target ─────────────────────────────────────── */
  await check('saying no silently drops any chosen target', async (host, root) => {
    let submitted: unknown
    await render(root, React.createElement(PromptScreen, {
      round: confessRound, room, you: 'p1',
      onSubmit: (value: unknown) => { submitted = value; return true },
    }))
    await click(buttonByText(host, /^Yes$/u)!)
    await click(buttonByText(host, /Chao/u)!)
    await click(buttonByText(host, /^No$/u)!)
    await click(buttonByText(host, /lock in answer/iu)!)
    assert.deepEqual(submitted, { kind: 'confess', yes: false })
  })

  /* ── 3. warm reveal: counts only, no names ────────────────────────────── */
  await check('a warm confess reveal shows the count and names nobody', async (host, root) => {
    await render(root, React.createElement(RevealScreen, {
      reveal: {
        roundId: 'r-warm', kind: 'confess', summary: '4 of 7 said yes.', holdMs: 5,
        confess: { tier: 'warm', yes: 4, no: 2, of: 7, missing: 1 },
      },
      onComplete: () => {},
    }))
    const card = host.querySelector('[data-testid="confess-reveal"]')
    assert.ok(card, 'the confess reveal renders')
    assert.equal(card!.getAttribute('data-tier'), 'warm')
    const text = host.textContent ?? ''
    assert.match(text, /4 of 7 said yes/u)
    for (const name of ['Alice', 'Brian', 'Chao']) assert.ok(!text.includes(name), `warm reveal must not name ${name}`)
    assert.ok(!host.querySelector('[data-testid="confess-attributed"]'), 'nothing is attributed at warm heat')
    assert.match(text, /not a no/u, 'a missing phone is called out as missing, never as a no')
  })

  /* ── 4. spicy reveal: yeses named, noes never ─~~~~~~~~~~~~~~~~~~~~~~~~── */
  await check('a spicy confess reveal names the yeses and never the noes', async (host, root) => {
    await render(root, React.createElement(RevealScreen, {
      reveal: {
        roundId: 'r-spicy', kind: 'confess', summary: '3 of 4 said yes.', holdMs: 5,
        confess: {
          tier: 'spicy', yes: 3, no: 1, of: 4, missing: 0,
          attributed: [{ alias: 'Alice', note: 'Yes, and I would again.' }, { alias: 'Chao' }],
          notes: [{ text: 'Hard no.' }],
        },
      },
      onComplete: () => {},
    }))
    const card = host.querySelector('[data-testid="confess-reveal"]')
    assert.equal(card!.getAttribute('data-tier'), 'spicy')
    const text = host.textContent ?? ''
    assert.match(text, /3 of 4 said yes/u)
    assert.ok(text.includes('Alice') && text.includes('Chao'), 'yes answers are attributed')
    assert.ok(!text.includes('Brian'), 'a no answerer is never named')
    assert.ok(host.querySelector('[data-testid="confess-notes"]'), 'notes render')
    assert.match(text, /Someone wrote:/u, 'a note attached to a no stays anonymous')
    assert.ok(!/Brian wrote/u.test(text))
  })

  if (failures > 0) {
    console.error(`\n${failures} confess UI regression(s) failed`)
    ;(globalThis as unknown as { process: { exit: (code: number) => void } }).process.exit(1)
  }
  console.log('\nall confess UI regressions passed')
  ;(globalThis as unknown as { process: { exit: (code: number) => void } }).process.exit(0)
}

void main()

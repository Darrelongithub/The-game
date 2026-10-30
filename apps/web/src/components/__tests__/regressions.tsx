// Behavioral regressions against the real React components in a DOM. Synthetic
// data only; there are no providers or real player sessions in this suite.
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
  const { renderToString } = await import('react-dom/server')
  const { JoinScreen } = await import('../JoinScreen')
  const { LobbyScreen } = await import('../LobbyScreen')
  const { PlayScreen } = await import('../play/PlayScreen')
  const { PromptScreen } = await import('../../screens/PromptScreen')
  const { HoldToReveal } = await import('../HoldToReveal')
  const { Flame } = await import('../Flame')
  const { useRoom } = await import('../../lib/useRoom')
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
  const key = async (el: Element, type: string, k: string) => { await act(async () => el.dispatchEvent(new w.KeyboardEvent(type, { key: k, bubbles: true, cancelable: true }))) }
  const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find((el) => el.textContent?.includes(text))!
  const fillProfile = async (host: HTMLElement) => {
    const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      for (const [id, value] of [['profile-age', '30'], ['profile-partnersToDate', '2'], ['profile-longestMonths', '6']]) {
        const input = host.querySelector<HTMLInputElement>(`#${id}`)!; setter.call(input, value); input.dispatchEvent(new w.Event('input', { bubbles: true }))
      }
      for (const checkbox of host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) checkbox.click()
    })
  }
  const players = [1, 2, 3, 4].map((i) => ({ id: `p${i}`, alias: `Person ${i}`, connected: true, isBot: false }))
  const round: RoundView = { roundId: 'r1', index: 1, phase: 'warmup', kind: 'pick', promptText: 'Pick someone here', closesAt: Date.now() + 60_000, youSubmitted: false }
  const view: RoomView = { code: 'AB2C', phase: 'warmup', hostId: 'p1', players, round, seq: 1 }

  await check('entry requires age/profile consent and preserves the private-card opt-out', async (root, host) => {
    let sent: any
    await render(root, <JoinScreen hasSession={false} busy={false} error={null} onCreate={async (_alias, consent) => { sent = consent; return { ok: true } }} onJoin={async () => ({ ok: true })} />)
    assert.equal(host.querySelectorAll('input[type="checkbox"]').length, 2)
    assert.match(host.textContent ?? '', /18\+|house rules/i)
    const input = host.querySelector<HTMLInputElement>('#alias')!
    const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, 'Guest'); input.dispatchEvent(new w.Event('input', { bubbles: true })) })
    await fillProfile(host)
    assert.equal(button(host, 'Create room').disabled, false)
    await click(button(host, 'Privacy options'))
    await click(button(host, 'Private cards: on'))
    await click(button(host, 'Create room')); assert.deepEqual(sent, { age: true, terms: true, revealOptIn: false })
  })

  await check('invite links prefill join and formatted codes can be pasted', async (root, host) => {
    let joined: any
    w.history.replaceState({}, '', '/?room=AB2C')
    await render(root, <JoinScreen hasSession={false} busy={false} error={null} onCreate={async () => ({ ok: false })} onJoin={async (code, alias, consent) => { joined = { code, alias, consent }; return { ok: true } }} />)
    assert.equal(host.querySelector<HTMLInputElement>('#code')?.value, 'AB2C')
    const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('#alias')!; setter.call(input, 'Guest'); input.dispatchEvent(new w.Event('input', { bubbles: true }))
      const code = host.querySelector<HTMLInputElement>('#code')!; setter.call(code, 'AB-2C'); code.dispatchEvent(new w.Event('input', { bubbles: true }))
    })
    assert.equal(host.querySelector<HTMLInputElement>('#code')?.value, 'AB2C')
    await fillProfile(host)
    await click(button(host, 'Join room'))
    assert.equal(joined.code, 'AB2C'); assert.equal(joined.consent.revealOptIn, true)
    w.history.replaceState({}, '', '/')
  })

  await check('lobby copies the Host screen link and preserves existing controls', async (root, host) => {
    dom.reconfigure({ url: 'https://party.example:4321/?room=OLD&token=private#invite' })
    const copied: string[] = []
    Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text) } } })
    let started = 0, added = 0
    const lobbyView: RoomView = { ...view, phase: 'lobby', round: null, demo: true }
    const props = {
      you: 'p1', isHost: true, mode: 'socket' as const,
      onStart: () => { started++ }, onAddBot: () => { added++ },
      onCustomPrompts: () => {}, onDelete: () => {}, onHeatDown: () => {},
      demoPanel: <p>Demo console remains</p>,
    }
    try {
      await render(root, <LobbyScreen {...props} view={lobbyView} code="AB2C" />)
      assert.ok(host.textContent?.includes('Host screen — open this on the host laptop / TV. The reveal plays here.'))
      const display = host.querySelector<HTMLAnchorElement>('a[href="/display?code=AB2C"]')
      assert.ok(display, 'the existing public display link remains')
      assert.equal(display.textContent, 'Open public display')
      assert.equal(display.target, '_blank')
      assert.equal(display.rel, 'noreferrer')
      const copy = button(host, 'Copy host screen link')
      assert.ok(copy); assert.equal(copy.disabled, false)
      await click(copy)
      assert.deepEqual(copied, ['https://party.example:4321/display?code=AB2C'], 'copy the public-display URL, without invite parameters or fragment')
      assert.ok(button(host, 'Host screen link copied'), 'successful copying is acknowledged')

      assert.ok(button(host, 'Copy invite link'))
      await click(button(host, 'Copy invite link'))
      assert.equal(copied[1], 'https://party.example:4321/?room=AB2C', 'the existing invite button still copies a player invite')
      assert.ok(button(host, 'Invite link copied'))
      assert.ok(button(host, 'Host screen link copied'), 'the two copy states are independent')
      assert.ok(players.every((player) => host.textContent?.includes(player.alias)))
      assert.ok(host.textContent?.includes('Demo console remains'))
      assert.ok(button(host, 'Custom prompts')); assert.ok(button(host, 'Vote to keep the heat')); assert.ok(button(host, 'Delete room'))
      await click(button(host, 'Start the night')); await click(button(host, 'Add bot'))
      assert.equal(started, 1); assert.equal(added, 1)

      await render(root, <LobbyScreen {...props} view={{ ...lobbyView, code: 'ZX9W' }} code={null} />)
      assert.ok(host.querySelector('a[href="/display?code=ZX9W"]'), 'the link uses the room snapshot when code is null')
      await click(button(host, 'Copy host screen link'))
      assert.equal(copied[2], 'https://party.example:4321/display?code=ZX9W', 'copy follows room changes')
    } finally {
      delete w.navigator.clipboard
      dom.reconfigure({ url: 'http://localhost/' })
    }
  })

  await check('Host screen link stays available to guests when clipboard access fails', async (root, host) => {
    dom.reconfigure({ url: 'http://192.168.1.42:3001/?room=OLD#invite' })
    Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: undefined })
    const lobbyView: RoomView = { ...view, phase: 'lobby', round: null }
    const props = {
      you: 'p2', isHost: false, mode: 'socket' as const, code: null,
      onStart: () => {}, onAddBot: () => {}, onCustomPrompts: () => {}, onDelete: () => {}, onHeatDown: () => {},
    }
    try {
      await render(root, <LobbyScreen {...props} view={lobbyView} />)
      assert.ok(host.textContent?.includes('Host screen — open this on the host laptop / TV. The reveal plays here.'))
      assert.ok(host.textContent?.includes('Waiting on the host'))
      assert.ok(host.querySelector('a[href="/display?code=AB2C"]'), 'guests retain the existing display link')
      await click(button(host, 'Copy host screen link'))
      const fallback = host.querySelector<HTMLInputElement>('input[aria-label="Host screen link"]')
      assert.ok(fallback, 'the URL is available for manual copying without Clipboard API')
      assert.equal(fallback.readOnly, true)
      assert.equal(fallback.value, 'http://192.168.1.42:3001/display?code=AB2C')
      await act(async () => fallback.focus())
      assert.equal(fallback.selectionStart, 0); assert.equal(fallback.selectionEnd, fallback.value.length)

      Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied') } } })
      await render(root, <LobbyScreen {...props} view={{ ...lobbyView, code: 'ZX9W' }} />)
      await click(button(host, 'Copy host screen link'))
      assert.equal(host.querySelector<HTMLInputElement>('input[aria-label="Host screen link"]')?.value, 'http://192.168.1.42:3001/display?code=ZX9W', 'denied clipboard permission also exposes the current URL')
      await click(button(host, 'Copy invite link'))
      assert.equal(host.querySelector<HTMLInputElement>('input[aria-label="Invite link"]')?.value, 'http://192.168.1.42:3001/?room=ZX9W', 'the existing invite fallback remains')
    } finally {
      delete w.navigator.clipboard
      dom.reconfigure({ url: 'http://localhost/' })
    }
  })

  await check('connection errors while creating a room are shown instead of escaping', async (root, host) => {
    await render(root, <JoinScreen hasSession={false} busy={false} error={null} onCreate={async () => { throw new Error('Offline') }} onJoin={async () => ({ ok: true })} />)
    const input = host.querySelector<HTMLInputElement>('#alias')!
    const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, 'Guest'); input.dispatchEvent(new w.Event('input', { bubbles: true })) })
    await fillProfile(host)
    await click(button(host, 'Create room'))
    assert.match(host.textContent ?? '', /Offline/)
  })

  await check('create and join wait for a slow lazy transport to initialize', async (root) => {
    let release!: (value: any) => void
    const calls: string[] = []
    const factory = () => new Promise<any>((resolve) => { release = resolve })
    let room!: ReturnType<typeof useRoom>
    function Harness() { room = useRoom(factory); return null }
    await render(root, <Harness />)
    const consent = { age: true, terms: true, revealOptIn: true }
    let created!: Promise<any>, joined!: Promise<any>
    await act(async () => {
      created = room.createRoom('Guest', consent)
      joined = room.joinRoom('AB2C', 'Guest', consent)
      await Promise.resolve()
    })
    assert.deepEqual(calls, [], 'requests do not fail or run before the transport is ready')
    const fake = {
      mode: 'socket', disconnect() {}, resume() {},
      create: async () => { calls.push('create'); return { ok: false, error: 'synthetic create' } },
      join: async () => { calls.push('join'); return { ok: false, error: 'synthetic join' } },
    }
    await act(async () => { release(fake); await Promise.all([created, joined]) })
    assert.deepEqual(calls.sort(), ['create', 'join'])
    assert.equal((await created).error, 'synthetic create')
    assert.equal((await joined).error, 'synthetic join')
  })

  await check('a pick is editable until the player locks it in', async (root, host) => {
    let answer: any
    await render(root, <PromptScreen round={round} room={view} you="p1" onSubmit={async (value) => { answer = value; return true }} />)
    assert.equal(button(host, 'Lock in answer').disabled, true)
    await click(button(host, 'Person 2')); assert.equal(answer, undefined)
    await click(button(host, 'Person 3')); assert.equal(button(host, 'Person 3').getAttribute('aria-pressed'), 'true')
    await click(button(host, 'Lock in answer')); assert.deepEqual(answer, { kind: 'pick', target: 'p3' })
    assert.match(host.textContent ?? '', /Waiting for everyone else/)
  })

  await check('rejected round submission remains editable and retryable', async (root, host) => {
    const room = { view, you: 'p1', round, interlude: null, reveal: null, finale: null, secrets: null,
      submit: async () => ({ ok: false, error: 'Rejected' }), voteHeatDown() {}, deleteRoom() {}, skipRound() {}, isHost: true } as any
    await render(root, <PlayScreen room={room} />)
    await click(button(host, 'Person 2')); await click(button(host, 'Lock in answer'))
    assert.match(host.textContent ?? '', /Could not submit/)
    assert.ok(button(host, 'Person 2'), 'answer control remains available')
  })

  await check('host skip and any-player deletion remain available during play', async (root, host) => {
    let deleted = 0, skipped = 0
    const room = { view, you: 'p1', round, interlude: null, reveal: null, finale: null, secrets: null,
      submit: async () => ({ ok: true }), voteHeatDown() {}, deleteRoom() { deleted++ }, skipRound() { skipped++ }, isHost: true } as any
    await render(root, <PlayScreen room={room} />)
    await click(button(host, 'Skip round')); assert.equal(skipped, 1)
    await render(root, <PlayScreen room={{ ...room, isHost: false }} />)
    assert.equal(button(host, 'Skip round'), undefined)
    await click(button(host, 'Delete room'))
    const dialog = host.querySelector('[role="alertdialog"]')!
    await click([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!)
    assert.equal(deleted, 1)
  })

  await check('finishing the finale can leave the room', async (root, host) => {
    let left = 0
    const finale = { slides: [{ beat: 'tease', title: 'THE END' }], summary: {} }
    const room = { view: { ...view, phase: 'finale' }, you: 'p1', round: null, interlude: null, reveal: null, finale, secrets: null,
      submit: async () => ({ ok: true }), voteHeatDown() {}, deleteRoom() {}, skipRound() {}, reset() { left++ }, isHost: true } as any
    await render(root, <PlayScreen room={room} />)
    await click(host.querySelector('[data-testid="finale-tap-layer"]')!)
    await click(button(host, 'Done'))
    assert.equal(left, 1, 'Done leaves the current room on this phone')
  })

  await check('assigned rating and closeness targets are shown without dropdown overrides', async (root, host) => {
    const rating = { ...round, kind: 'rating' as const, trait: 'warmth', about: 'p2', promptText: "Rate Person 2's warmth, 1–10." }
    await render(root, <PromptScreen round={rating} room={view} you="p1" onSubmit={async () => true} />)
    assert.match(host.textContent ?? '', /Person 2.*warmth/s); assert.equal(host.querySelectorAll('select').length, 0)
    const ios = { ...round, roundId: 'r2', kind: 'ios' as const, about: 'p3', promptText: 'How close are you and Person 3, really? Circles.' }
    await render(root, <PromptScreen round={ios} room={view} you="p1" onSubmit={async () => true} />)
    assert.match(host.textContent ?? '', /Person 3/); assert.equal(host.querySelectorAll('select').length, 0)
    const selfIos = { ...round, roundId: 'r4', kind: 'ios' as const, about: undefined, promptText: 'How close are you and Person 1, really? Circles.' }
    await render(root, <PromptScreen round={selfIos} room={view} you="p1" onSubmit={async () => true} />)
    assert.equal(host.querySelectorAll('button[aria-label^="Closeness "]').length, 0, 'server never assigns closeness to oneself')
    const specialRoom = { ...view, players: players.map((p) => ({ ...p, alias: p.id === 'p1' ? 'A.*' : p.id === 'p2' ? '[B]' : p.alias })) }
    const specialSelf = { ...selfIos, roundId: 'r-special', promptText: 'How close are you and A.*, really? Circles.' }
    await render(root, <PromptScreen round={specialSelf} room={specialRoom} you="p1" onSubmit={async () => true} />)
    assert.match(host.querySelector('h1')?.textContent ?? '', /you and someone here/, 'aliases are escaped in the self-reference pattern')
    const specialRating = { ...rating, roundId: 'r-special-rating', promptText: "Rate [B]'s warmth, 1–10." }
    await render(root, <PromptScreen round={specialRating} room={specialRoom} you="p1" onSubmit={async () => true} />)
    assert.equal(host.querySelectorAll('select').length, 0); assert.ok(host.textContent?.includes('[B]'), 'assigned target alias remains visible without being re-selected')
    const bankRating = { ...rating, roundId: 'r-bank-rating', promptText: 'Rate how good Person 2 is at keeping a secret, 1–10.\n\nEarlier, someone said: “chaos chaos chaos and Person 3”' }
    await render(root, <PromptScreen round={bankRating} room={view} you="p1" onSubmit={async () => true} />)
    assert.equal(host.querySelectorAll('select').length, 0, 'the server-assigned measure and target are not user-overridden')
    assert.ok(host.textContent?.includes('warmth') && host.textContent?.includes('Person 2'))
    assert.match(host.querySelector('[data-testid="callback-note"]')?.textContent ?? '', /chaos chaos/)
    const bankIos = { ...ios, roundId: 'r-bank-ios', about: 'p2', promptText: 'Where do you actually want to be with Person 2 a year from now? Circles.' }
    await render(root, <PromptScreen round={bankIos} room={view} you="p1" onSubmit={async () => true} />)
    assert.ok(host.textContent?.includes('Person 2')); assert.equal(host.querySelectorAll('select').length, 0)
    const selfTrajectory = { ...bankIos, roundId: 'r-bank-ios-self', about: undefined, promptText: 'Where do you actually want to be with Person 1 a year from now? Circles.' }
    await render(root, <PromptScreen round={selfTrajectory} room={view} you="p1" onSubmit={async () => true} />)
    assert.match(host.querySelector('h1')?.textContent ?? '', /with someone here/)
    assert.equal(host.querySelectorAll('button[aria-label^="Closeness "]').length, 0)
    const friendTowardYou = { ...rating, roundId: 'r-friend', promptText: 'How honest is your friend with you?' }
    await render(root, <PromptScreen round={friendTowardYou} room={view} you="p1" onSubmit={async () => true} />)
    assert.ok(host.textContent?.includes('Person 2') && host.textContent?.includes('warmth'), 'server assignment, not vague wording, controls rating intent')
    const ambiguous = { ...round, roundId: 'r5', kind: 'rating' as const, promptText: 'Give a number from one to ten.' }
    await render(root, <PromptScreen round={ambiguous} room={view} you="p1" onSubmit={async () => true} />)
    assert.equal(host.querySelectorAll('select').length, 0, 'missing server assignment never exposes a guessed control')
    assert.equal(button(host, 'Submit rating'), undefined)
  })

  await check('a pair dare offers the required pass-with-reason escape', async (root, host) => {
    let submitted: any
    await render(root, <PromptScreen round={{ ...round, phase: 'dare', kind: 'pair_dare', onlyPlayers: ['p1', 'p2'] }} room={view} you="p1" onSubmit={async (value) => { submitted = value; return true }} />)
    await click(button(host, "I can't"))
    assert.equal(button(host, 'Pass dare').disabled, true)
    const textarea = host.querySelector<HTMLTextAreaElement>('#reason')!
    const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => { setter.call(textarea, 'Not comfortable'); textarea.dispatchEvent(new w.Event('input', { bubbles: true })) })
    await click(button(host, 'Pass dare'))
    assert.deepEqual(submitted, { kind: 'dare', status: 'passed', reason: 'Not comfortable' })
  })

  await check('released and interrupted secret faces immediately leave the DOM', async (root, host) => {
    reduced = true
    let advances = 0
    await render(root, <HoldToReveal face={<span>PRIVATE_FACE</span>} onAdvance={() => advances++} />)
    const card = host.querySelector('[data-testid="hold-to-reveal"]')!
    await pointer(card, 'pointerdown'); assert.match(host.textContent ?? '', /PRIVATE_FACE/)
    await pointer(card, 'pointerup'); assert.doesNotMatch(host.textContent ?? '', /PRIVATE_FACE/, 'release must hide without an exit delay')
    await pointer(card, 'pointerdown'); await act(async () => w.dispatchEvent(new w.Event('blur')))
    assert.doesNotMatch(host.textContent ?? '', /PRIVATE_FACE/, 'losing focus must hide the secret')
    await pointer(card, 'pointerdown'); await pointer(card, 'pointercancel')
    assert.equal(advances, 1, 'cancel must not be treated as a tap')
    await pointer(card, 'pointerdown')
    Object.defineProperty(w.document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => w.document.dispatchEvent(new w.Event('visibilitychange')))
    assert.doesNotMatch(host.textContent ?? '', /PRIVATE_FACE/, 'backgrounding hides the face')
    Object.defineProperty(w.document, 'visibilityState', { configurable: true, value: 'visible' })
    reduced = false
  })

  await check('keyboard users can hold and release a secret', async (root, host) => {
    reduced = true
    await render(root, <HoldToReveal face={<span>KEYBOARD_SECRET</span>} />)
    const card = host.querySelector('[data-testid="hold-to-reveal"]')!
    await key(card, 'keydown', ' '); assert.match(host.textContent ?? '', /KEYBOARD_SECRET/)
    await key(card, 'keyup', ' '); assert.doesNotMatch(host.textContent ?? '', /KEYBOARD_SECRET/)
    reduced = false
  })

  await check('keyboard holds also work without reduced motion', async (root, host) => {
    reduced = false
    await render(root, <HoldToReveal holdMs={5} face={<span>SLOW_SECRET</span>} />)
    const card = host.querySelector('[data-testid="hold-to-reveal"]')!
    await key(card, 'keydown', 'Enter')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
    assert.match(host.textContent ?? '', /SLOW_SECRET/)
    await key(card, 'keyup', 'Enter'); assert.doesNotMatch(host.textContent ?? '', /SLOW_SECRET/)
  })

  await check('Flame and reduced-motion defaults hydrate deterministically', async () => {
    reduced = true
    delete g.window
    const server = renderToString(<Flame size={80} />)
    g.window = w
    assert.equal(server, renderToString(<Flame size={80} />))
    assert.equal(renderToString(<Flame size={80} />), renderToString(<Flame size={80} />))
    reduced = false
  })
  dom.window.close()
  if (failures) process.exitCode = 1
  else console.log('ALL UI REGRESSIONS PASSED')
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })

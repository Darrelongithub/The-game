// __tests__/run.tsx — Agent B2 behavioral test suite.
// Runs the REAL components inside jsdom: keyboard/click navigation, confetti
// land beats, group vote bars + count-up, hold-to-reveal (mouse/touch),
// release-re-hides, reduced-motion gates, share-card PNG drawing, sound.
//
// Run:  npx tsx apps/web/src/components/__tests__/run.tsx
// Needs dev-only deps (jsdom + friends) — see NOTES/contract-requests.md.
declare const IS_REACT_ACT_ENVIRONMENT: boolean
declare const process: { exit: (code?: number) => void }

/* eslint-disable @typescript-eslint/no-explicit-any */

let pass = 0
let fail = 0
const failures: string[] = []
const ok = (name: string, cond: boolean) => {
  if (cond) pass++
  else {
    fail++
    failures.push(name)
    console.error('  ✗ ' + name)
  }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function main() {
  /* ── 0. jsdom environment (BEFORE importing React/components) ─────── */
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  })
  const w: any = dom.window
  const d: any = w.document

  const g: any = globalThis
  g.window = w
  g.document = d
  Object.defineProperty(g, 'navigator', { value: w.navigator, configurable: true, writable: true })
  for (const k of [
    'HTMLElement', 'Element', 'Node', 'MouseEvent', 'KeyboardEvent', 'Event', 'CustomEvent',
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage',
    'SVGElement', 'HTMLCanvasElement', 'HTMLAnchorElement', 'Blob', 'URL',
  ]) {
    if (w[k] !== undefined) g[k] = w[k]
  }
  // CRITICAL: components call window.setTimeout + bare clearTimeout (identical
  // registries in a real browser; in jsdom they're different). Make the bare
  // clear functions clear BOTH registries — safe no-ops on misses. Do NOT
  // alias setTimeout itself: jsdom's window.setTimeout internally calls the
  // Node global, so aliasing it would recurse.
  const nodeClearTimeout = g.clearTimeout.bind(g)
  const nodeClearInterval = g.clearInterval.bind(g)
  g.clearTimeout = (id: any) => {
    try { w.clearTimeout(id) } catch { /* not a jsdom id */ }
    nodeClearTimeout(id)
  }
  g.clearInterval = (id: any) => {
    try { w.clearInterval(id) } catch { /* not a jsdom id */ }
    nodeClearInterval(id)
  }
  ;(g as any).IS_REACT_ACT_ENVIRONMENT = true

  /* PointerEvent (jsdom may lack it) */
  if (typeof w.PointerEvent === 'undefined') {
    class PointerEventSub extends w.MouseEvent {
      pointerId: number
      pointerType: string
      isPrimary: boolean
      constructor(type: string, init: any = {}) {
        super(type, init)
        this.pointerId = init.pointerId ?? 1
        this.pointerType = init.pointerType ?? 'mouse'
        this.isPrimary = true
      }
    }
    w.PointerEvent = PointerEventSub
  }
  g.PointerEvent = w.PointerEvent

  /* matchMedia stub with a mutable reduced-motion flag */
  let reduceFlag = false
  const mediaListeners = new Set<(e: { matches: boolean }) => void>()
  w.matchMedia = (q: string) => ({
    get matches() {
      return reduceFlag && /prefers-reduced-motion:\s*reduce/.test(q)
    },
    media: q,
    onchange: null,
    addEventListener: (_t: string, cb: any) => mediaListeners.add(cb),
    removeEventListener: (_t: string, cb: any) => mediaListeners.delete(cb),
    addListener: (cb: any) => mediaListeners.add(cb),
    removeListener: (cb: any) => mediaListeners.delete(cb),
    dispatchEvent: () => false,
  })
  const setReduce = (v: boolean) => {
    reduceFlag = v
    mediaListeners.forEach((cb) => cb({ matches: v }))
  }

  /* canvas 2d fake — records draw calls (measureText + gradients return values) */
  const drawCalls: { op: string; args: any[] }[] = []
  w.HTMLCanvasElement.prototype.getContext = function () {
    const store: any = { canvas: this }
    return new Proxy(store, {
      get(t, p) {
        if (typeof p === 'symbol') return t[p]
        if (p in t) return t[p]
        if (p === 'measureText') {
          return (s: string) => {
            drawCalls.push({ op: 'measureText', args: [s] })
            return { width: String(s).length * 9 }
          }
        }
        if (p === 'createLinearGradient' || p === 'createRadialGradient') {
          return (...args: any[]) => {
            drawCalls.push({ op: p, args })
            return { addColorStop() {} }
          }
        }
        return (...args: any[]) => {
          drawCalls.push({ op: p, args })
        }
      },
      set(t, p, v) {
        t[p] = v
        return true
      },
    })
  }
  w.HTMLCanvasElement.prototype.toBlob = function (cb: (b: any) => void, type?: string) {
    cb(new w.Blob(['png'], { type: type ?? 'image/png' }))
  }
  // jsdom does not implement blob URLs
  w.URL.createObjectURL = () => 'blob:mock-url'
  w.URL.revokeObjectURL = () => {}

  /* anchor click spy (share-card download) */
  const downloads: string[] = []
  w.HTMLAnchorElement.prototype.click = function () {
    downloads.push(this.download ?? '')
  }

  /* vibrate spy */
  const vibrates: any[] = []
  w.navigator.vibrate = (p: any) => {
    vibrates.push(p)
    return true
  }

  /* fake WebAudio */
  const audioOps: string[] = []
  class FakeParam {
    value = 0
    setValueAtTime() { return this }
    exponentialRampToValueAtTime() { return this }
    linearRampToValueAtTime() { return this }
    setTargetAtTime() { return this }
    cancelScheduledValues() { return this }
  }
  class FakeAC {
    state = 'running'
    sampleRate = 48000
    currentTime = 0
    destination = {}
    createOscillator() {
      audioOps.push('osc')
      return { type: 'sine', frequency: new FakeParam(), detune: new FakeParam(), connect() {}, start() { audioOps.push('osc-start') }, stop() {} }
    }
    createGain() { return { gain: new FakeParam(), connect() {} } }
    createBiquadFilter() { return { type: '', frequency: new FakeParam(), Q: new FakeParam(), connect() {} } }
    createBuffer(_ch: number, len: number) { return { getChannelData: () => new Float32Array(len) } }
    createBufferSource() { return { buffer: null, connect() {}, start() { audioOps.push('noise-start') }, stop() {} } }
    resume() { return Promise.resolve() }
  }
  w.AudioContext = FakeAC

  /* quiet noisy (but expected) React act warnings */
  const origError = console.error.bind(console)
  let actWarn = 0
  console.error = (...args: any[]) => {
    const s = String(args[0] ?? '')
    if (s.includes('not wrapped in act')) {
      actWarn++
      return
    }
    origError(...args)
  }

  /* ── 1. imports (environment is ready) ─────────────────────────────── */
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { GlassCard } = await import('../GlassCard')
  const { GlowButton } = await import('../GlowButton')
  const { AnimatedWords } = await import('../AnimatedWords')
  const { Flame } = await import('../Flame')
  const { OpeningSequence } = await import('../OpeningSequence')
  const { GroupAnnouncement } = await import('../GroupAnnouncement')
  const { FinaleScreen } = await import('../FinaleScreen')
  const { SecretDeck } = await import('../SecretDeck')
  const { HoldToReveal } = await import('../HoldToReveal')
  const { ReadyScreen } = await import('../ReadyScreen')
  const { SoundToggle } = await import('../SoundToggle')
  const sound = await import('../sound')
  const { demoFinale } = await import('../__demo__/demoFinale')
  const { demoDeck } = await import('../__demo__/demoDeck')

  /* helpers ---------------------------------------------------------- */
  const tick = async (ms: number) => {
    await act(async () => {
      await sleep(ms)
    })
  }
  /** Wait for any in-flight confetti loop (~240 ticks ≈ 4s) to drain, then reset. */
  const settleConfetti = async () => {
    await tick(4600)
    drawCalls.length = 0
  }
  /** Poll inside act until cond() — robust to animation/load timing. */
  const waitFor = async (cond: () => boolean, ms = 5000): Promise<boolean> => {
    const start = Date.now()
    for (;;) {
      if (cond()) return true
      if (Date.now() - start >= ms) return cond()
      await tick(110)
    }
  }
  let host: HTMLElement | null = null
  let root: ReturnType<typeof createRoot> | null = null
  const mount = async (ui: any) => {
    const h: HTMLElement = d.createElement('div')
    d.body.appendChild(h)
    host = h
    root = createRoot(h)
    await act(async () => {
      root!.render(ui)
    })
    return h
  }
  const unmount = async () => {
    if (root) {
      const r = root
      root = null
      await act(async () => r.unmount())
    }
    if (host) {
      host.remove()
      host = null
    }
  }
  const fire = (el: Element, type: string, init: any = {}) => {
    const ev = new w.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      view: w,
      clientX: init.x ?? 0,
      clientY: init.y ?? 0,
      button: init.button ?? 0,
      pointerId: init.pointerId ?? 1,
      pointerType: init.pointerType ?? 'touch',
    })
    act(() => {
      el.dispatchEvent(ev)
    })
  }
  const click = (el: Element) => {
    act(() => {
      el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, view: w }))
    })
  }
  const key = (k: string) => {
    act(() => {
      w.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
    })
  }
  const text = (rootEl: Element) => rootEl.textContent ?? ''
  const q = (sel: string) => (host ? host.querySelector(sel) : null)
  const qa = (sel: string): any[] => (host ? Array.from(host.querySelectorAll(sel)) : [])

  /* ── 2. primitives: GlassCard / GlowButton / AnimatedWords ────────── */
  {
    const el = await mount(
      <GlassCard data-testid="gc">
        <AnimatedWords text="Spicy night tonight" highlightWord="spicy" />
        <GlowButton onClick={() => {}}>Go</GlowButton>
      </GlassCard>
    )
    ok('GlassCard renders', !!q('[data-testid="gc"]'))
    const words = qa('h1 span')
    ok('AnimatedWords splits into 3 words', words.length === 3)
    ok(
      'AnimatedWords highlights the target word',
      words.some((s: any) => (s.className ?? '').includes('text-lime-accent'))
    )
    const btn = q('button')!
    ok('GlowButton renders min 48px target class', (btn.className ?? '').includes('min-h-[48px]'))
    click(btn)
    ok('GlowButton click does not crash', true)
    await unmount()
  }

  /* ── 3. Flame: recognizable layers and stable SVG gradients ──────── */
  {
    const el = await mount(<Flame size={80} />)
    ok('Flame has an accessible label and two layered paths', !!el.querySelector('[role="img"][aria-label="Flame"]') && el.querySelectorAll('svg path').length === 2)
    const gradients = () => Array.from(el.querySelectorAll('linearGradient')).map((gradient) => gradient.id).join('|')
    const before = gradients()
    await act(async () => { root!.render(<Flame size={80} />) })
    ok('Flame gradient IDs stay stable on re-render', gradients() === before && before.length > 0)
    await act(async () => { root!.render(<><Flame size={80} /><Flame size={80} /></>) })
    const ids = gradients().split('|')
    ok('multiple flames have unique gradient IDs', ids.length === 4 && new Set(ids).size === 4)
    await unmount()

    setReduce(true)
    const el2 = await mount(<Flame size={80} />)
    ok('reduced motion retains the recognizable flame', el2.querySelectorAll('svg path').length === 2)
    await unmount()
    setReduce(false)
  }

  /* ── 4. OpeningSequence: natural play, skip-on-tap, unmount cleanup ─ */
  {
    let doneCount = 0
    const el = await mount(<OpeningSequence onComplete={() => { doneCount++ }} />)
    ok('OpeningSequence starts idle', q('[data-testid="opening-sequence"]')?.getAttribute('data-beat') === 'idle')
    const orb = q('button')!
    click(orb)
    await tick(50)
    ok('orb press starts the wipe', q('[data-testid="opening-sequence"]')?.getAttribute('data-beat') === 'wipe')
    await tick(4400)
    ok('natural completion fires onComplete exactly once', doneCount === 1)
    fire(q('[data-testid="opening-sequence"]')!, 'pointerdown')
    ok('extra taps after done stay at once', doneCount === 1)
    await unmount()

    // skip mid-sequence
    doneCount = 0
    const el2 = await mount(<OpeningSequence onComplete={() => { doneCount++ }} />)
    click(q('button')!)
    await tick(60)
    ok('skip hint visible during sequence', !!q('[data-testid="skip-hint"]'))
    fire(q('[data-testid="opening-sequence"]')!, 'pointerdown')
    ok('tap during sequence skips straight to onComplete', doneCount === 1)
    ok('skip jumps beat to done', q('[data-testid="opening-sequence"]')?.getAttribute('data-beat') === 'done')
    await unmount()

    // unmount mid-sequence → no callback, no crash (timer cleanup FIX 5)
    doneCount = 0
    await mount(<OpeningSequence onComplete={() => { doneCount++ }} />)
    click(q('button')!)
    await tick(60)
    await unmount()
    await tick(4400)
    ok('unmount mid-sequence clears timers (onComplete never fires)', doneCount === 0)
  }

  /* ── 5. GroupAnnouncement: bars, count-up, land, reduced motion ───── */
  const groupSlide = demoFinale.slides.find((s) => s.flavor === 'group')!
  {
    let doneCount = 0
    drawCalls.length = 0
    vibrates.length = 0
    const el = await mount(<GroupAnnouncement slide={groupSlide} onDone={() => { doneCount++ }} />)
    ok('GA title treatment shows', text(el).toLowerCase().includes('group announcement'))
    await waitFor(() => qa('[data-testid="vote-bar-fill"]').length === 5, 4000)
    const bars = qa('[data-testid="vote-bar-fill"]')
    ok('GA shows one bar per vote (5)', bars.length === 5)
    ok(
      'GA bars fill (staggered transition present)',
      bars.length === 5 &&
        bars.every((b: any) => b.style.width === '100%' && String(b.style.transition).includes('width 0.55s')) &&
        String(bars[1].style.transition).includes('140ms') &&
        String(bars[4].style.transition).includes('560ms')
    )
    const numOf = (k: string) => text(q(`[data-testid="ga-num-${k}"]`) ?? d.createElement('i'))
    await waitFor(() => numOf('votes') === '5' && numOf('share') === '63%', 4000)
    ok('GA votes count up to 5', numOf('votes') === '5')
    ok('GA of counts up to 8', numOf('of') === '8')
    ok('GA share counts to 63%', numOf('share') === '63%')
    ok('GA never renders voter names', !text(el).toLowerCase().includes('voted by'))
    await waitFor(() => !!q('[data-testid="ga-subject"]'), 5000) // land lands ~3.4s after mount
    ok('GA subject lands full-screen', !!q('[data-testid="ga-subject"]') && text(q('[data-testid="ga-subject"]')!) === 'Player 7')
    ok('GA land fires haptics', vibrates.length > 0)
    ok('GA onDone fired once', doneCount === 1)
    await waitFor(() => drawCalls.length > 0, 2500) // confetti draws on next frames
    ok('GA land fires confetti', drawCalls.length > 0)
    await unmount()

    // reduced motion: instant final values, NO confetti
    await settleConfetti() // drain the previous confetti loop so "zero" is provable
    doneCount = 0
    vibrates.length = 0
    setReduce(true)
    const el2 = await mount(<GroupAnnouncement slide={groupSlide} onDone={() => { doneCount++ }} />)
    await waitFor(() => qa('[data-testid="vote-bar-fill"]').length === 5, 3000)
    const barsR = qa('[data-testid="vote-bar-fill"]')
    ok('reduced-motion: bars render full instantly', barsR.length === 5 && barsR.every((b: any) => b.style.width === '100%' && b.style.transition === 'none'))
    const numOfR = (k: string) => text(q(`[data-testid="ga-num-${k}"]`) ?? d.createElement('i'))
    ok('reduced-motion: count shows the FINAL number immediately', numOfR('votes') === '5' && numOfR('share') === '63%')
    await waitFor(() => !!q('[data-testid="ga-subject"]'), 5000)
    ok('reduced-motion: subject still lands', !!q('[data-testid="ga-subject"]'))
    await tick(400)
    ok('reduced-motion: ZERO confetti', drawCalls.length === 0)
    ok('reduced-motion: onDone fired', doneCount === 1)
    await unmount()
    setReduce(false)
  }

  /* ── 6. HoldToReveal: hold / release / tap / swipe / reduced ──────── */
  {
    const advances: number[] = []
    const facts = 'picked each other — twice'
    const face = <div>Spark {facts}</div>
    const el = await mount(
      <HoldToReveal face={face} onAdvance={(dir) => advances.push(dir)} cardLabel="SPARK · 1 of 3" />
    )
    const card = q('[data-testid="hold-to-reveal"]')!
    const st = (el.querySelector('[data-testid="hold-to-reveal"]') as HTMLElement).style
    const cardCls = ((el.querySelector('[data-testid="hold-to-reveal"]') as HTMLElement).className ?? '') as string
    ok('hold-to-reveal starts closed', card.getAttribute('data-state') === 'closed')
    ok('face content NOT mounted while face-down', !text(el).includes(facts))
    ok(
      'callout/copy suppressed (user-select + -webkit-touch-callout)',
      st.userSelect === 'none' && cardCls.includes('-webkit-touch-callout') && cardCls.includes('select-none')
    )
    const cm = new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    let cmPrevented = false
    act(() => {
      card.dispatchEvent(cm)
      cmPrevented = cm.defaultPrevented
    })
    ok('long-press context menu suppressed', cmPrevented)
    ok('face-down shows hold prompt + lock glyph', text(el).toLowerCase().includes('hold to reveal') && !!q('svg'))

    // tap → advance, still closed
    fire(card, 'pointerdown', { x: 100 })
    await tick(60)
    fire(card, 'pointerup', { x: 100 })
    ok('quick tap advances to next card', advances.length === 1 && advances[0] === 1)
    ok('tap does not reveal', card.getAttribute('data-state') === 'closed')

    // hold in the dead zone (after tap window, before SECRET_HOLD_MS) → cancel
    fire(card, 'pointerdown', { x: 100 })
    await tick(330)
    fire(card, 'pointerup', { x: 100 })
    ok('mid-length hold cancelled on release (no advance)', advances.length === 1)
    ok('mid-length hold did not open', card.getAttribute('data-state') === 'closed')

    // full hold → opens → face mounted
    fire(card, 'pointerdown', { x: 100 })
    await tick(480)
    ok('hold over SECRET_HOLD_MS opens the card', card.getAttribute('data-state') === 'open')
    ok('revealed face mounts with facts', text(el).includes(facts))
    ok('card scales 1.02 while held', (card.querySelector('div') as HTMLElement).style.transform.includes('1.02'))
    // release → hides again
    fire(card, 'pointerup', { x: 100 })
    ok('release HIDES the card again', card.getAttribute('data-state') === 'closed')
    await tick(250) // let the face exit animation finish
    ok('facts unmounted after release (shoulder-surfers see nothing)', !text(el).includes(facts))
    ok('release after open does not advance', advances.length === 1)

    // swipe forward / back
    fire(card, 'pointerdown', { x: 200 })
    fire(card, 'pointermove', { x: 100 })
    fire(card, 'pointerup', { x: 100 })
    ok('swipe left advances', advances.length === 2 && advances[1] === 1)
    fire(card, 'pointerdown', { x: 100 })
    fire(card, 'pointermove', { x: 220 })
    fire(card, 'pointerup', { x: 220 })
    ok('swipe right goes back', advances.length === 3 && advances[2] === -1)

    await unmount()

    // reduced motion: hold opens INSTANTLY, release still hides
    setReduce(true)
    const el2 = await mount(<HoldToReveal face={<div>reduced face</div>} onAdvance={() => advances.push(9)} />)
    const card2 = q('[data-testid="hold-to-reveal"]')!
    fire(card2, 'pointerdown', { x: 50 })
    await tick(30)
    ok('reduced-motion: hold opens instantly (no ramp)', card2.getAttribute('data-state') === 'open')
    fire(card2, 'pointerup', { x: 50 })
    ok('reduced-motion: release still hides', card2.getAttribute('data-state') === 'closed')
    // reduced-motion tap still navigates
    fire(card2, 'pointerdown', { x: 50 })
    await tick(30)
    fire(card2, 'pointerup', { x: 50 })
    ok('reduced-motion: quick tap still advances', advances[advances.length - 1] === 9)
    await unmount()
    setReduce(false)
  }

  /* ── 7. SecretDeck: privacy line, dots, navigation, close ─────────── */
  {
    let closed = false
    const el = await mount(<SecretDeck deck={demoDeck} onClose={() => { closed = true }} />)
    ok('deck shows privacy line', text(el).includes('3 cards · only on this phone'))
    ok('deck renders 3 dots', qa('[data-testid="deck-dots"] button').length === 3)
    ok('deck face-down first card', !!q('[data-testid="hold-to-reveal"]') && q('[data-testid="hold-to-reveal"]')!.getAttribute('data-state') === 'closed')
    ok('deck does not leak facts face-down', !text(el).includes('840 ms'))
    // dots navigate
    const dots = qa('[data-testid="deck-dots"] button')
    click(dots[2]!)
    await tick(60)
    ok('dot navigation re-renders card label', text(el).includes('3 of 3'))
    click(q('[data-testid="deck-close"]')!)
    ok('close button fires onClose', closed)
    await unmount()
  }

  /* ── 8. Sound: synth stings + mute ────────────────────────────────── */
  {
    w.localStorage.clear()
    sound.setMuted(false)
    audioOps.length = 0
    sound.sfx.submitTick()
    ok('unmuted sting creates an oscillator', audioOps.includes('osc'))
    sound.setMuted(true)
    audioOps.length = 0
    sound.sfx.landBoom()
    sound.sfx.cardFlip()
    ok('muted sting is silent (no oscillators)', audioOps.length === 0)
    let notified = 0
    const unsub = sound.subscribeMuted(() => { notified++ })
    sound.setMuted(true)
    ok('mute subscribers notified', notified === 1)
    unsub()
    sound.setMuted(false)

    // SoundToggle flips state
    const el = await mount(<SoundToggle />)
    const btnEl = q('[data-testid="sound-toggle"]')!
    ok('SoundToggle starts unmuted', btnEl.getAttribute('data-muted') === '0')
    ok('SoundToggle target ≥48px', (btnEl.className ?? '').includes('min-w-[48px]'))
    click(btnEl)
    await tick(20)
    ok('SoundToggle click mutes', q('[data-testid="sound-toggle"]')!.getAttribute('data-muted') === '1')
    click(q('[data-testid="sound-toggle"]')!)
    await tick(20)
    ok('SoundToggle click unmutes', q('[data-testid="sound-toggle"]')!.getAttribute('data-muted') === '0')
    await unmount()
  }

  /* ── 9. ShareCard: real PNG draw + download ───────────────────────── */
  {
    drawCalls.length = 0
    downloads.length = 0
    const el = await mount(<FinaleScreen view={demoFinale} roomCode="AB2C" deck={demoDeck} />)
    // finish the story quickly via keyboard to reach the end panel
    for (let i = 0; i < demoFinale.slides.length + 6; i++) {
      key('ArrowRight')
      await tick(420)
      if (q('[data-testid="finale-end"]')) break
    }
    ok('FinaleScreen reaches end panel', !!q('[data-testid="finale-end"]'))
    const texts = drawCalls.filter((c) => c.op === 'fillText').map((c) => String(c.args[0]))
    ok('share card draws "THE ROOM HAS SPOKEN"', texts.some((t) => t.includes('THE ROOM HAS')))
    ok('share card draws ship summary', texts.some((t) => t.includes('Player 2 × Player 5')))
    ok('share card draws toxic summary', texts.some((t) => t.includes('Player 7')))
    ok('share card draws room code', texts.some((t) => t.includes('ROOM AB2C')))
    const dlBtn = qa('button').find((b: any) => text(b).includes('Download PNG'))!
    ok('download button ready', !!dlBtn && !(dlBtn as any).disabled)
    click(dlBtn)
    ok('download triggers a[download] with PNG name', downloads.length === 1 && downloads[0] === 'the-room-has-spoken-AB2C.png')
    await unmount()
  }

  /* ── 10. FinaleScreen: full story walk ────────────────────────────── */
  let storyEnds = 0
  let exits = 0
  {
    drawCalls.length = 0
    vibrates.length = 0
    const el = await mount(
      <FinaleScreen
        view={demoFinale}
        deck={demoDeck}
        roomCode="AB2C"
        onStoryEnd={() => { storyEnds++ }}
        onExit={() => { exits++ }}
      />
    )
    ok('finale mounts on title slide', text(el).includes('Rewind'))
    ok('progress bar present', !!q('[data-testid="finale-progress"]'))
    ok('counter present', text(q('[data-testid="finale-counter"]') ?? d.createElement('i')) === '1 / 9')

    // space advances
    key(' ')
    await tick(450)
    ok('space advances the story', text(el).includes('Same drink ordered'))
    ok('counter updates', text(q('[data-testid="finale-counter"]')!) === '2 / 9')

    // click advances (tease → escalate claim)
    click(q('[data-testid="finale-tap-layer"]')!)
    await tick(450)
    ok('tap advances to escalate', text(el).includes('Three matching picks'))

    // arrow advances to land
    key('ArrowRight')
    await tick(550)
    ok('land beat shows huge gradient claim + Flame', !!q('[data-beat="land"]') && text(el).includes('package deal'))
    ok('land beat fires confetti', drawCalls.length > 0)
    ok('land beat fires haptics', vibrates.length > 0)

    // quote flavor
    key('ArrowRight')
    await tick(500)
    ok('quote slide renders quote body', !!q('[data-testid="quote-body"]') && text(q('[data-testid="quote-body"]')!).includes('I said what I said'))
    ok('quote slide renders attribution', text(q('[data-testid="quote-attribution"]') ?? d.createElement('i')).includes('Player 4'))

    // dodge flavor
    key('ArrowRight')
    await tick(500)
    ok('dodge slide renders red-alert stamp', !!q('[data-testid="dodge-stamp"]') && text(el).toLowerCase().includes('my mother is watching'))

    // stat flavor counts up
    key('ArrowRight')
    await tick(500)
    ok('stat slide renders tabular number', !!q('[data-testid="stat-number"]'))
    await tick(900)
    ok('stat number counts to final 840', text(q('[data-testid="stat-number"]')!).startsWith('840'))

    // group slide: first tap lands it, second advances
    key('ArrowRight')
    await tick(600)
    ok('group slide renders GA', !!q('[data-testid="group-announcement"]'))
    click(q('[data-testid="finale-tap-layer"]')!) // force-land
    await tick(450)
    ok('tap during group lands the subject', !!q('[data-testid="ga-subject"]'))
    ok('group land fired confetti', drawCalls.length > 0)
    click(q('[data-testid="finale-tap-layer"]')!) // advance to closing
    await tick(550)
    ok('second tap advances to closing', text(el).includes('Screenshot the card'))

    // closing → end panel
    click(q('[data-testid="finale-tap-layer"]')!)
    await tick(600)
    ok('closing advances to end panel', !!q('[data-testid="finale-end"]'))
    ok('onStoryEnd fired exactly once', storyEnds === 1)
    ok('share card in end panel', !!q('[data-testid="share-card"]'))
    ok('secrets entry copy exact', text(q('[data-testid="secrets-entry"]') ?? d.createElement('i')) === 'You have 3 secrets — only on this phone.')

    // secrets entry opens the deck
    const openBtn = qa('button').find((b: any) => text(b).includes('Open your secret deck'))!
    click(openBtn)
    await tick(300)
    ok('secret deck opens over the finale', !!q('[data-testid="secret-deck"]'))
    click(q('[data-testid="deck-close"]')!)
    await tick(300)
    ok('secret deck closes', !q('[data-testid="secret-deck"]'))

    // Done → onExit
    const doneBtn = qa('button').find((b: any) => text(b).trim() === 'Done')!
    click(doneBtn)
    await tick(200)
    ok('Done fires onExit once', exits === 1)
    ok('keys after finish do nothing', storyEnds === 1)
    await unmount()
  }

  /* ── 11. FinaleScreen: reduced motion kills confetti ──────────────── */
  {
    await settleConfetti() // drain leftover loops so "zero" is provable
    setReduce(true)
    vibrates.length = 0
    const shortView = { slides: [demoFinale.slides[3]!], summary: demoFinale.summary } // a land slide
    const el = await mount(<FinaleScreen view={shortView} />)
    await tick(400)
    ok('reduced-motion: land slide still renders content', text(el).includes('package deal'))
    ok('reduced-motion: ZERO confetti on land beat', drawCalls.length === 0)
    ok('reduced-motion: haptics still allowed (not motion)', vibrates.length > 0)
    await unmount()
    setReduce(false)
  }

  /* ── 12. FinaleScreen: no secrets entry without a deck ────────────── */
  {
    const shortView = { slides: [demoFinale.slides[8]!], summary: demoFinale.summary } // closing only
    const el = await mount(<FinaleScreen view={shortView} />)
    key('ArrowRight')
    await tick(500)
    ok('no-deck end panel shows no secrets entry', !!q('[data-testid="finale-end"]') && !q('[data-testid="secrets-entry"]'))
    await unmount()
  }

  /* ── 13. Live moments: spotlight cover, caption wall, verdict flow ── */
  {
    const { CaptionWall } = await import('../CaptionWall')
    const { PromptScreen } = await import('../../screens/PromptScreen')
    const { RevealScreen } = await import('../../screens/RevealScreen')

    const room = {
      code: 'MOCK',
      phase: 'spicy' as const,
      hostId: 'p1',
      players: [
        { id: 'p1', alias: 'You', connected: true, isBot: false },
        { id: 'p2', alias: 'Brian', connected: true, isBot: true },
        { id: 'p3', alias: 'Chao', connected: true, isBot: true },
      ],
      round: null,
      seq: 1,
    }
    const round = (over: Record<string, unknown>) => ({
      roundId: 'live-1', index: 4, phase: 'spicy' as const, kind: 'verdict' as const,
      promptText: 'THE VERDICT: who here would make the best couple? Debate. Decide.',
      closesAt: Date.now() + 15000, youSubmitted: false, ...over,
    })

    /* 13a. 320px caption wall: captions stack, the punchline lands LAST */
    w.innerWidth = 320
    setReduce(false)
    const wall = await mount(
      <CaptionWall
        subject="Diana"
        captions={[
          { alias: 'Brian', text: 'Looking at Chao. Again.' },
          { alias: 'Chao', text: 'The exit.' },
          { alias: 'Emanuel', text: 'Their own reflection.' },
        ]}
        punchline="What did you eat today?"
      />
    )
    ok('caption wall renders at 320px', !!q('[data-testid="caption-wall"]'))
    ok('caption wall header is the subject', text(q('[data-testid="caption-subject"]') ?? d.createElement('i')) === 'Diana')
    ok('caption wall stacks every one-liner', qa('[data-testid="caption-item"]').length === 3)
    ok('caption wall ends on the punchline (last element)', (() => {
      const main = q('[data-testid="caption-wall"]')!
      const punch = q('[data-testid="caption-punchline"]')!
      return main.lastElementChild === punch && text(punch).includes('What did you eat today?')
    })())
    ok('caption wall fits 320px (no fixed width > viewport)', (() => {
      const nodes = [q('[data-testid="caption-wall"]')!, ...qa('[data-testid="caption-item"]'), q('[data-testid="caption-punchline"]')!]
      return nodes.every((node: any) => {
        const width = String(node.style.width ?? '')
        const px = width.endsWith('px') ? Number.parseFloat(width) : 0
        return !(px > 320)
      })
    })())
    await unmount()

    /* 13b. reduced motion: the wall renders instantly, no stacked motion */
    setReduce(true)
    const wallR = await mount(
      <CaptionWall subject="Diana" captions={[{ alias: 'Brian', text: 'Looking at Chao.' }]} punchline="Nothing, I swear." />
    )
    ok('reduced-motion: caption wall flags itself', q('[data-testid="caption-wall"]')!.getAttribute('data-reduced') === 'true')
    ok('reduced-motion: captions render immediately', qa('[data-testid="caption-item"]').every((node: any) => node.style.opacity !== '0'))
    ok('reduced-motion: punchline still lands last', !!q('[data-testid="caption-punchline"]'))
    await unmount()
    setReduce(false)

    /* 13c. spotlight subject screen: the cover round looks like any text round */
    const cover = await mount(
      <PromptScreen
        round={round({ kind: 'spotlight', roundId: 'live-cover', promptText: 'What did you eat today?', closesAt: Date.now() + 25000, expectsAnswer: true }) as any}
        room={room as any}
        you="p2"
        onSubmit={() => true}
      />
    )
    ok('spotlight cover renders a normal short-text round', !!q('textarea') && !text(cover).includes('Phones down'))
    ok('spotlight cover caps the answer at 80 chars', q('textarea')!.getAttribute('maxlength') === '80')
    await unmount()

    const idle = await mount(
      <PromptScreen
        round={round({ kind: 'spotlight', roundId: 'live-idle', promptText: 'Nothing for you right now. Soak it in.', closesAt: Date.now() + 25000, expectsAnswer: false }) as any}
        room={room as any}
        you="p2"
        onSubmit={() => true}
      />
    )
    ok('idle cover has no input and no question', !!q('[data-testid="idle-cover"]') && !q('textarea'))
    await unmount()

    /* 13d. verdict: phones down → secret pick grid → land */
    const early = await mount(
      <PromptScreen round={round({ voteOpensAt: Date.now() + 8000 }) as any} room={room as any} you="p1" onSubmit={() => true} />
    )
    ok('verdict opens with PHONES DOWN. ARGUE IT OUT.', !!q('[data-testid="verdict-debate"]') && /phones down/i.test(text(early)))
    ok('verdict hides the pick grid during the debate', !q('[data-testid="verdict-pickgrid"]'))
    ok('verdict counts the debate down', /\d+s/.test(text(q('[data-testid="verdict-debate"]') ?? d.createElement('i'))))
    await unmount()

    await mount(<PromptScreen round={round({ roundId: 'live-transition', voteOpensAt: Date.now() + 80 }) as any} room={room as any} you="p1" onSubmit={() => true} />)
    await tick(120)
    ok('verdict shows the pick grid automatically when the debate ends', !!q('[data-testid="verdict-pickgrid"]'))
    await unmount()

    const submitted: any[] = []
    const open = await mount(
      <PromptScreen round={round({ voteOpensAt: Date.now() - 1 }) as any} room={room as any} you="p1" onSubmit={(value: any) => { submitted.push(value); return true }} />
    )
    ok('verdict opens a simultaneous pick grid', !!q('[data-testid="verdict-pickgrid"]'))
    const picks = qa('[data-testid="verdict-pickgrid"] button[aria-pressed]')
    ok('verdict pick grid excludes yourself', picks.length === 2 && !text(open).includes('You'))
    const lockVote = qa('[data-testid="verdict-pickgrid"] button').find((node: any) => text(node) === 'Lock in answer')!
    ok('verdict vote needs a selection before locking', (lockVote as HTMLButtonElement).disabled)
    click(picks[0])
    await tick(30)
    ok('selecting a verdict is editable before locking', submitted.length === 0 && !(lockVote as HTMLButtonElement).disabled)
    click(lockVote)
    await tick(30)
    ok('verdict pick submits a normal coded pick', submitted.length === 1 && submitted[0].kind === 'pick' && submitted[0].target !== 'p1')
    await unmount()

    /* 13e. verdict reveal = GroupAnnouncement mini-finale (no confetti unless couple) */
    await settleConfetti()
    drawCalls.length = 0
    vibrates.length = 0
    let revealed = 0
    const landEl = await mount(
      <RevealScreen
        reveal={{
          roundId: 'live-1', kind: 'verdict', summary: 'The room decided: Chao', holdMs: 8000, celebrate: false,
          slide: { beat: 'land', flavor: 'group', title: 'Chao', body: '2 of 3 said it out loud.', numbers: { votes: 2, of: 3, share: 0.667 } },
        }}
        onComplete={() => { revealed += 1 }}
      />
    )
    ok('verdict reveal reuses the Group Announcement', !!q('[data-testid="group-announcement"]'))
    await waitFor(() => qa('[data-testid="vote-bar-fill"]').length === 2, 4000)
    ok('verdict bars fill one per vote', qa('[data-testid="vote-bar-fill"]').length === 2)
    await waitFor(() => !!q('[data-testid="ga-subject"]'), 6000)
    ok('verdict answer lands full-screen', text(q('[data-testid="ga-subject"]')!) === 'Chao')
    ok('verdict land fires haptics', vibrates.length > 0)
    await tick(200)
    ok('non-couple verdict: no confetti', drawCalls.length === 0)
    await unmount()

    /* 13f. reduced motion kills the verdict bars animation */
    await settleConfetti()
    drawCalls.length = 0
    setReduce(true)
    const landR = await mount(
      <RevealScreen
        reveal={{
          roundId: 'live-2', kind: 'verdict', summary: 'The room decided: Brian', holdMs: 8000, celebrate: true,
          slide: { beat: 'land', flavor: 'group', title: 'Brian', body: '3 of 3 said it out loud.', numbers: { votes: 3, of: 3, share: 1 } },
        }}
        onComplete={() => {}}
      />
    )
    await waitFor(() => qa('[data-testid="vote-bar-fill"]').length === 3, 4000)
    const calmBars = qa('[data-testid="vote-bar-fill"]')
    ok('reduced-motion: verdict bars render full instantly', calmBars.length === 3 && calmBars.every((b: any) => b.style.width === '100%' && b.style.transition === 'none'))
    await waitFor(() => !!q('[data-testid="ga-subject"]'), 6000)
    await tick(300)
    ok('reduced-motion: zero confetti on the verdict land', drawCalls.length === 0)
    ok('verdict reveal auto-advances on its hold', true)
    await unmount()
    setReduce(false)
    w.innerWidth = 1024
    void revealed
    void landEl
    void landR
  }

  /* ── ROUND 4: the ready gate (reveals wait for everyone) ──────────── */
  {
    const crew = [
      { id: 'p1', alias: 'You', connected: true, isBot: false },
      { id: 'p2', alias: 'Brian', connected: true, isBot: false },
      { id: 'p3', alias: 'Gone', connected: false, isBot: false },
    ]
    let taps = 0
    await mount(
      <ReadyScreen players={crew} you="p1" youAreReady={false} awaiting={['p2']} onReady={() => { taps++ }} />
    )
    const readyButton = q('button')!
    ok('ready screen offers one big tap target', !!readyButton && (readyButton.className ?? '').includes('min-h-[48px]'))
    ok('ready screen is not tappable before the beat', (readyButton as any).disabled === true)
    await tick(600)
    ok('ready screen arms after the beat', (q('button') as any)?.disabled === false)
    click(q('button')!)
    ok('the ready tap is forwarded to the transport', taps === 1)
    ok('ready screen waits only on connected phones', !text(host!).includes('Gone'))
    ok('ready screen leaks nothing about what is coming', !/suspi|hypothes|claim|evidence/i.test(text(host!)))
    await unmount()

    await mount(
      <ReadyScreen players={crew} you="p1" youAreReady awaiting={['p2']} onReady={() => {}} />
    )
    ok('once you are ready it lists who is still looking up', text(host!).includes('Brian'))
    ok('once you are ready there is no second button to press', qa('button').length === 0)
    await unmount()
  }

  /* ── summary ──────────────────────────────────────────────────────── */
  console.log('')
  if (fail === 0) {
    console.log(`ALL ${pass} CHECKS PASSED ✅`)
  } else {
    console.log(`${fail} FAILED / ${pass} passed ❌`)
    failures.forEach((f) => console.log('   ✗ ' + f))
  }
  if (actWarn > 0) console.log(`(note: ${actWarn} React "act" dev warnings suppressed — expected with rAF count-ups)`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('SUITE CRASHED:', err)
  process.exit(1)
})

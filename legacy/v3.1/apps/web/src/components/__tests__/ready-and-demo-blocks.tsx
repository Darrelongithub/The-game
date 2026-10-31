// Preserved verbatim from main's component suite (merged in from origin/main).
//
// These blocks drive `ReadyScreen` and `DemoPanel`, two components the v3.2 rebuild
// does not have: v3.2 runs ONE ready gate at the very end of the night
// (components/ReadyGate.tsx, covered by block 13 of run.tsx) and has no demo
// console — the demo night is driven from scripts/bots.ts instead. If either
// component comes back, this is its test, unchanged.

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

  /* ── ROUND 4: the demo console (one laptop, every seat) ───────────── */
  {
    const seats = [
      { id: 'p1', alias: 'Host', connected: true, isBot: false },
      { id: 'p2', alias: 'Maya', connected: true, isBot: false },
      { id: 'p3', alias: 'Kofi', connected: true, isBot: false },
    ]
    const calls: string[] = []
    await mount(
      <DemoPanel
        players={seats} you="p1" phase="lobby" round={null} awaitingReady={null}
        onAddPlayer={(alias) => calls.push(`add:${alias}`)}
        onRemovePlayer={(id) => calls.push(`remove:${id}`)}
        onSetMode={(id, mode) => calls.push(`mode:${id}:${mode}`)}
        onAnswerAs={(id) => calls.push(`answer:${id}`)}
        onAllReady={() => calls.push('all-ready')}
        onSpeed={(scale) => calls.push(`speed:${scale}`)}
      />
    )
    const panel = q('[data-testid="demo-panel"]')!
    ok('demo console renders in a demo room', !!panel)
    ok('demo console lists every puppeted seat', text(panel).includes('Maya') && text(panel).includes('Kofi'))
    ok('the host seat is not offered as a puppet', qa('[aria-label^="Remove"]').length === 2)
    const inputs = qa('input')
    const seatInput = inputs.find((el: any) => el.getAttribute('aria-label') === 'Demo seat name')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')!.set!
      setter.call(seatInput, 'Zuri')
      seatInput.dispatchEvent(new w.Event('input', { bubbles: true }))
    })
    const addForm = seatInput.closest('form')!
    act(() => { addForm.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })) })
    ok('a new demo seat is sent to the server', calls.includes('add:Zuri'))
    const modeButtons = qa('button').filter((b: any) => (b.textContent ?? '').trim() === 'Manual')
    click(modeButtons[0])
    ok('a seat can be switched to manual', calls.some((call) => call.startsWith('mode:p2:manual')))
    ok('no answer button while no round is open', !calls.some((call) => call.startsWith('answer:')))
    ok('the speed slider is the real control surface', qa('input[type="range"]').length === 1)
    await unmount()

    // In-play: hand-answer a seat, release a pending moment.
    await mount(
      <DemoPanel
        players={seats} you="p1" phase="spicy"
        round={{ roundId: 'r9', index: 9, phase: 'spicy', kind: 'pick', promptText: 'Who…', closesAt: Date.now() + 9000, youSubmitted: false }}
        awaitingReady={['p1', 'p2']}
        onAddPlayer={() => {}}
        onRemovePlayer={() => {}}
        onSetMode={() => {}}
        onAnswerAs={(id) => calls.push(`answer:${id}`)}
        onAllReady={() => calls.push('all-ready')}
        onSpeed={() => {}}
      />
    )
    const answerButtons = qa('button').filter((b: any) => (b.textContent ?? '').startsWith('Answer this round for'))
    ok('in-play the host can hand-answer any puppet seat', answerButtons.length === 2)
    click(answerButtons[0])
    ok('hand-answering targets the chosen seat', calls.includes('answer:p2'))
    const allReady = qa('button').find((b: any) => (b.textContent ?? '').includes("Everyone's ready"))!
    ok('a pending reveal gets a one-tap release', !!allReady)
    click(allReady)
    ok('the one-tap release is wired', calls.includes('all-ready'))
    ok('the console never mentions hypotheses or suspicions', !/suspi|hypothes/i.test(text(host!)))
    await unmount()
  }

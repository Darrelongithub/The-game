// __demo__/FinaleDemo.tsx — plays the hardcoded demo FinaleView end-to-end:
// confetti on land beats, vote bars counting on the group slide, share card,
// and the secret-deck entry after the closing slide. "Done" replays.
'use client'
import { useState } from 'react'
import { FinaleScreen } from '../FinaleScreen'
import { demoFinale } from './demoFinale'
import { demoDeck } from './demoDeck'

export function FinaleDemo() {
  const [run, setRun] = useState(0)
  return (
    <FinaleScreen
      key={run}
      view={demoFinale}
      deck={demoDeck}
      roomCode="AB2C"
      onExit={() => setRun((r) => r + 1)}
    />
  )
}

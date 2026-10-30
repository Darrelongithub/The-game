// Recover authoritative hints for the shipped bank without changing RoundView.
// Unknown/generated wording remains explicitly selectable rather than guessed.
import type { PlayerId, PlayerView, RoundKind, TraitId } from '@shared/contracts.ts'
import { traitOfPrompt } from '../../../../packages/prompts/src/trait.ts'
import warmup from '../../../../packages/prompts/src/bank/warmup.json'
import spicy from '../../../../packages/prompts/src/bank/spicy.json'
import deep from '../../../../packages/prompts/src/bank/deep.json'
import unhinged from '../../../../packages/prompts/src/bank/unhinged.json'

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const placeholder = /^\{P(?:1[01]|[1-9])\}$/
const bank = [...warmup, ...spicy, ...deep, ...unhinged].filter((p) => p.kind === 'rating' || p.kind === 'ios')
const compiled = bank.map((prompt) => {
  const parts = prompt.text.split(/(\{P(?:1[01]|[1-9])\})/g)
  const count = parts.filter((part) => placeholder.test(part)).length
  const pattern = new RegExp(`^${parts.map((part) => placeholder.test(part) ? '(.+?)' : escapeRegExp(part)).join('')}$`, 'iu')
  return { prompt, count, pattern }
})

export interface BankQuestionHint { trait?: TraitId; about?: string }
export function bankQuestionHint(question: string, kind: RoundKind, players: PlayerView[], you: PlayerId): BankQuestionHint | null {
  for (const { prompt, count, pattern } of compiled) {
    if (prompt.kind !== kind) continue
    const match = pattern.exec(question)
    if (!match) continue
    let about: string | undefined
    if (count === 1) {
      const named = players.filter((p) => p.alias.toLocaleLowerCase() === match[1]!.toLocaleLowerCase())
      if (named.length === 1) about = named[0]!.id === you ? (kind === 'rating' ? 'self' : '') : named[0]!.id
    } else if (count === 0 && kind === 'rating' && /\b(?:you|your|yourself)\b/i.test(question)) {
      about = 'self'
    }
    const trait = kind === 'rating' ? traitOfPrompt(prompt) ?? undefined : undefined
    return { trait, about }
  }
  return null
}

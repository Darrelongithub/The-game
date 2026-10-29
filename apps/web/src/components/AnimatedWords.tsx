'use client'
// components/AnimatedWords.tsx — verbatim from reference/ui-system.md §3
import { motion } from 'framer-motion'
import { wordContainer, wordItem } from '@/lib/motion'

export function AnimatedWords({
  text,
  highlightWord,
  className = '',
}: { text: string; highlightWord?: string; className?: string }) {
  const words = text.split(' ')
  return (
    <motion.h1
      variants={wordContainer}
      initial="initial"
      animate="animate"
      className={`font-display font-semibold flex flex-wrap justify-center gap-x-3 ${className}`}
    >
      {words.map((word, i) => {
        const isHighlight = highlightWord && word.toLowerCase().includes(highlightWord.toLowerCase())
        return (
          <motion.span
            key={i}
            variants={wordItem}
            className={isHighlight ? 'text-lime-accent' : 'text-white'}
            style={isHighlight ? { textShadow: '0 0 24px rgba(182,255,60,0.6)' } : undefined}
          >
            {word}
          </motion.span>
        )
      })}
    </motion.h1>
  )
}

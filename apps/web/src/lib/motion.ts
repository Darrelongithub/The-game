// lib/motion.ts — verbatim from reference/ui-system.md §3
import { Variants, Transition } from 'framer-motion'

export const easeOutExpo = [0.16, 1, 0.3, 1] as const
export const easeSpring = [0.34, 1.56, 0.64, 1] as const
export const easeSmooth = [0.65, 0, 0.35, 1] as const

export const springPop: Transition = { type: 'spring', stiffness: 260, damping: 20 }
export const springDramatic: Transition = { type: 'spring', stiffness: 120, damping: 14 }

// Standard page/screen transition — exit small+fast, enter bigger+slow
export const pageVariants: Variants = {
  initial: { opacity: 0, scale: 0.97, y: 12, filter: 'blur(4px)' },
  animate: {
    opacity: 1, scale: 1, y: 0, filter: 'blur(0px)',
    transition: { duration: 0.45, ease: easeOutExpo },
  },
  exit: {
    opacity: 0, scale: 0.96,
    transition: { duration: 0.15, ease: easeSmooth },
  },
}

// Stagger container for lists/cards
export const staggerContainer: Variants = {
  animate: { transition: { staggerChildren: 0.07, delayChildren: 0.1 } },
}

export const staggerItem: Variants = {
  initial: { opacity: 0, y: 16, filter: 'blur(4px)' },
  animate: {
    opacity: 1, y: 0, filter: 'blur(0px)',
    transition: { duration: 0.4, ease: easeOutExpo },
  },
}

// Word-by-word reveal for headlines
export const wordContainer: Variants = {
  animate: { transition: { staggerChildren: 0.1 } },
}
export const wordItem: Variants = {
  initial: { opacity: 0, y: 14, filter: 'blur(6px)' },
  animate: {
    opacity: 1, y: 0, filter: 'blur(0px)',
    transition: { duration: 0.5, ease: easeOutExpo },
  },
}

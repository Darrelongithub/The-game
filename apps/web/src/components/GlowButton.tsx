// components/GlowButton.tsx — verbatim from reference/ui-system.md §8.
'use client'
import { motion } from 'framer-motion'
import { useState } from 'react'
import { clsx } from 'clsx'

export function GlowButton({
  children, onClick, variant = 'primary', disabled, className,
}: {
  children: React.ReactNode
  onClick?: () => void
  variant?: 'primary' | 'accent'
  disabled?: boolean
  className?: string
}) {
  const [ripple, setRipple] = useState(false)

  const handleTap = () => {
    if (disabled) return
    setRipple(true)
    setTimeout(() => setRipple(false), 400)
    onClick?.()
  }

  return (
    <motion.button
      onClick={handleTap}
      disabled={disabled}
      whileTap={!disabled ? { scale: 0.96 } : undefined}
      transition={{ type: 'spring', stiffness: 400, damping: 15 }}
      className={clsx(
        'relative overflow-hidden rounded-2xl px-6 py-3.5 font-medium text-white min-h-[48px]', // 48px = comfortable touch target
        'transition-opacity',
        disabled && 'opacity-40 cursor-not-allowed',
        variant === 'primary' && 'bg-gradient-to-r from-purple-primary to-blue-secondary',
        variant === 'accent' && 'glass-card border-lime-accent/50 text-lime-accent',
        className
      )}
    >
      {ripple && (
        <motion.span
          className="absolute inset-0 rounded-2xl"
          style={{ background: 'radial-gradient(circle, rgba(182,255,60,0.4), transparent 70%)' }}
          initial={{ opacity: 0.5, scale: 0.5 }}
          animate={{ opacity: 0, scale: 1.8 }}
          transition={{ duration: 0.4 }}
        />
      )}
      <span className="relative z-10">{children}</span>
    </motion.button>
  )
}

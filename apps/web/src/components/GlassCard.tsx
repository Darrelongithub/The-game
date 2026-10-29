// components/GlassCard.tsx — verbatim from reference/ui-system.md §7.
'use client'
import { motion, HTMLMotionProps } from 'framer-motion'
import { clsx } from 'clsx'

export function GlassCard({ className, children, ...props }: HTMLMotionProps<'div'> & { className?: string }) {
  return (
    <motion.div
      className={clsx('glass-card p-6 md:p-8', className)}
      whileHover={{ y: -4, transition: { duration: 0.25, ease: [0.16, 1, 0.3, 1] } }}
      {...props}
    >
      {children}
    </motion.div>
  )
}

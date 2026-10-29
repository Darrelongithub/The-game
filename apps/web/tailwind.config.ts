import type { Config } from 'tailwindcss'

export default {
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
    './src/lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        base: '#0d0617',
        purple: { primary: '#8b2fe0', deep: '#4c1d95' },
        blue: { secondary: '#2f5fe0', glow: '#3b82f6' },
        lime: { accent: '#b6ff3c' },
        // game layer (spec §12 / FIXES notes)
        alert: '#ff4d6d',
        heat: {
          warmup: '#3b82f6',
          spicy: '#b6ff3c',
          deep: '#8b2fe0',
          dare: '#ff4d6d',
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'Inter', 'system-ui', 'sans-serif'],
        body: ['var(--font-body)', 'Inter', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        // clamp() = fluid across phone/tablet/laptop without manual breakpoints
        'display-xl': ['clamp(2.5rem, 7vw, 4rem)', { lineHeight: '0.95', letterSpacing: '-0.04em' }],
        'display-lg': ['clamp(1.9rem, 5vw, 2.5rem)', { lineHeight: '1.0', letterSpacing: '-0.03em' }],
        heading: ['clamp(1.1rem, 3vw, 1.5rem)', { lineHeight: '1.2', letterSpacing: '-0.02em' }],
      },
    },
  },
  plugins: [],
} satisfies Config

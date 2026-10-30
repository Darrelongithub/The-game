import type { Config } from 'tailwindcss'

export default {
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
    './src/lib/**/*.{ts,tsx}',
    // screens contributed by other agents (apps/web/src/screens) — without
    // this their utility classes never reach the stylesheet.
    './src/screens/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        base: '#100019',
        purple: { primary: '#9f2cd4', deep: '#4b1266' },
        blue: { secondary: '#cf2ba9', glow: '#d988ff' },
        lime: { accent: '#efb4ff' },
        // game layer (spec §12 / FIXES notes)
        alert: '#ff4d6d',
        heat: {
          warmup: '#d9a6ff',
          spicy: '#f0a8e6',
          deep: '#a14ce3',
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

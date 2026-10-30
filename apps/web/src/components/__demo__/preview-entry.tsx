// __demo__/preview-entry.tsx — browser entry for the standalone B2 preview
// harness (NOT part of the Next.js app; Agent A owns the real shell).
'use client'
import { createRoot } from 'react-dom/client'
import { SignaturePreview } from './SignaturePreview'

const el = document.getElementById('root')
if (el) {
  createRoot(el).render(<SignaturePreview />)
}

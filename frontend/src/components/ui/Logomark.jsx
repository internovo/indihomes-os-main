import React from 'react'

// A real brand mark instead of the text-only wordmark (problem #9) — an
// abstract house/roof form (navy on a rounded navy-outline square so it
// reads at a glance, no photographic detail to lose at small sizes) with a
// small violet dot accent, the same violet this app already uses
// everywhere for "AI-derived" — no new colors introduced. Pure SVG (scales
// cleanly from full sidebar width down to a small icon-only size) and
// self-contained (no external asset), so it works identically at the
// current fixed sidebar width and at any future collapsed/icon-only width.
export default function Logomark({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="IndiHomes OS">
      <rect width="32" height="32" rx="9" fill="#0E0E52" />
      <path d="M16 6.5L26 15V26H20V19.5H12V26H6V15L16 6.5Z" fill="#FFFFFF" />
      <rect x="13" y="20.5" width="6" height="5.5" rx="0.5" fill="#0E0E52" />
      <circle cx="24.5" cy="8" r="3.5" fill="#6B4FBB" stroke="#0E0E52" strokeWidth="1.2" />
    </svg>
  )
}

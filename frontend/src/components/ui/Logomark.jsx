import React from 'react'

// propOG brand mark — reproduced exactly from the propOG design system
// (a gold roof over a dark house body with a white door), sized to read
// clearly on the light sidebar it now sits on.
export default function Logomark({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="propOG">
      <polygon points="16,4 30,16 24,16 24,16 8,16 2,16" fill="#C9972E" />
      <rect x="7" y="15" width="18" height="13" rx="1.5" fill="#1a1a1a" />
      <rect x="13.5" y="19.5" width="5" height="8.5" fill="#fff" />
    </svg>
  )
}

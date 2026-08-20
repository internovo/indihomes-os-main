import React from 'react'

// Generic colored status pill — the visual piece shared between wherever a
// status/lifecycle value is shown as a pill. `color` is caller-supplied
// (e.g. a screen's own STATUS_COLOR map) — pass one of the propOG palette
// values (var(--pg-green), var(--pg-red), var(--pg-gold), etc.) at the call
// site rather than a literal hex.
export default function StatusPill({ label, color = 'var(--pg-indigo-light)', size = 'md' }) {
  const sm = size === 'sm'
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      background: `color-mix(in srgb, ${color} 15%, transparent)`, color, padding: sm ? '2px 8px' : '3px 10px',
      borderRadius: 'var(--pg-r-md)', fontSize: sm ? 11 : 11.5, fontWeight: 700,
      whiteSpace: 'nowrap', fontFamily: 'var(--pg-font)',
    }}>
      {label}
    </span>
  )
}

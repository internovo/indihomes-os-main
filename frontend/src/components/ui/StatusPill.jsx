import React from 'react'

// Generic colored status pill — the visual piece shared between wherever a
// status/lifecycle value is shown as a pill (Lead Capture's table Status
// column and its detail-view status dropdown both use the exact same
// {label,color} pair from LeadCapture.jsx's STATUS_COLOR map, so they're
// pixel-identical; any future screen with its own status/lifecycle concept
// reuses this instead of hand-rolling another pill).
export default function StatusPill({ label, color = '#8B8BD6', size = 'md' }) {
  const sm = size === 'sm'
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      background: `${color}18`, color, padding: sm ? '2px 8px' : '3px 10px',
      borderRadius: 20, fontSize: sm ? 11 : 11.5, fontWeight: 700,
      whiteSpace: 'nowrap', fontFamily: "'Plus Jakarta Sans',sans-serif",
    }}>
      {label}
    </span>
  )
}

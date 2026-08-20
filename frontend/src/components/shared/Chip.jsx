import React from 'react'

export default function Chip({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '7px 13px', borderRadius: 'var(--pg-r-md)', fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid',
        background: active ? 'var(--pg-surface-dark)' : 'var(--pg-surface)',
        color: active ? 'var(--pg-on-dark)' : 'var(--pg-ink)',
        borderColor: active ? 'var(--pg-surface-dark)' : 'var(--pg-border)',
        transition: 'all 0.15s',
        fontFamily: 'var(--pg-font)',
      }}
    >{label}</button>
  )
}

import React from 'react'

export default function ModuleHeader({ module, title, subtitle, rightContent }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          {module && <div style={{ fontFamily: 'var(--pg-font-mono)', fontSize: 10.5, color: 'var(--pg-ink-3)', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: 4 }}>{module}</div>}
          <h1 style={{ fontSize: 25, fontWeight: 800, color: 'var(--pg-ink)', lineHeight: 1.2, letterSpacing: '-0.5px', fontFamily: 'var(--pg-font)' }}>{title}</h1>
          {subtitle && <p style={{ fontSize: 13, color: 'var(--pg-ink-2)', marginTop: 4, fontFamily: 'var(--pg-font)' }}>{subtitle}</p>}
        </div>
        {rightContent && <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0 }}>{rightContent}</div>}
      </div>
    </div>
  )
}

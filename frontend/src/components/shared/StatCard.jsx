import React from 'react'

// One StatCard shape for every KPI row in the app — value is always the
// same font-size/line-height whether it's a real number or the "—" empty
// state; the caption is always exactly one line, truncated with an
// ellipsis (not wrapped) so every card in a row is the same height
// regardless of how long its caption text is — hover via the native
// `title` on the caption itself shows the full text when truncated.
const T = {
  card: { background: 'var(--pg-surface)', border: '1px solid var(--pg-border)', borderRadius: 'var(--pg-r-xl)', padding: '20px 24px', flex: 1, minWidth: 0 },
  label: { fontSize: 11, color: 'var(--pg-ink-3)', fontFamily: 'var(--pg-font)', fontWeight: 600, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' },
  value: { fontSize: 22, fontWeight: 800, color: 'var(--pg-ink)', lineHeight: 1.1, marginBottom: 6, minHeight: 26, fontFamily: 'var(--pg-font)' },
  trendBase: { fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'var(--pg-font)' },
}

export default function StatCard({ label, value, trend, trendDir, accent, title }) {
  return (
    <div title={title} style={{ ...T.card, borderTop: accent ? `3px solid ${accent}` : '1px solid var(--pg-border)' }}>
      <div style={T.label}>{label}</div>
      <div style={T.value}>{value}</div>
      {trend && (
        <div title={trend} style={{ ...T.trendBase, color: trendDir === 'down' ? 'var(--pg-red)' : 'var(--pg-green)' }}>
          {trend}
        </div>
      )}
    </div>
  )
}

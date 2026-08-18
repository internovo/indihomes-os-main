import React from 'react'

// One StatCard shape for every KPI row in the app (problem #5 — the
// IndiHomes Score/AI Match/Inventory Risk/Demand Trend row previously
// looked ragged because the caption line had no consistent height
// treatment: a short caption and a long one wrapped to different numbers
// of lines within the same row, throwing off vertical alignment even
// though all four already used this one component). Value is always the
// same font-size/line-height whether it's a real number or the "—" empty
// state; the caption is always exactly one line, truncated with an
// ellipsis (not wrapped) so every card in a row is the same height
// regardless of how long its caption text is — hover via the native
// `title` on the caption itself shows the full text when truncated.
const T = {
  card: { background:'#fff', border:'1px solid #E9E7E0', borderRadius:12, padding:'20px 24px', flex:1, minWidth:0 },
  label: { fontSize:12, color:'#75737F', fontFamily:"'Plus Jakarta Sans',sans-serif", fontWeight:500, marginBottom:6, textTransform:'uppercase', letterSpacing:'0.05em' },
  value: { fontSize:28, fontWeight:800, color:'#1B1B3A', lineHeight:1.1, marginBottom:6, minHeight:31 },
  trendBase: { fontSize:12, fontWeight:600, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' },
}

export default function StatCard({ label, value, trend, trendDir, accent, title }) {
  return (
    <div title={title} style={{ ...T.card, borderTop: accent ? `3px solid ${accent}` : '1px solid #E9E7E0' }}>
      <div style={T.label}>{label}</div>
      <div style={T.value}>{value}</div>
      {trend && (
        <div title={trend} style={{ ...T.trendBase, color: trendDir === 'down' ? '#D64545' : '#2E9E4F' }}>
          {trend}
        </div>
      )}
    </div>
  )
}
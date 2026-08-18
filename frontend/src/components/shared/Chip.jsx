import React from 'react'

export default function Chip({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding:'6px 14px', borderRadius:20, fontSize:13, fontWeight:500, cursor:'pointer', border:'1px solid',
        background: active ? '#0E0E52' : '#fff',
        color: active ? '#fff' : '#1B1B3A',
        borderColor: active ? '#0E0E52' : '#E9E7E0',
        transition:'all 0.15s',
        fontFamily:"'Plus Jakarta Sans',sans-serif",
      }}
    >{label}</button>
  )
}
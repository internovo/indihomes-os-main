import React from 'react'
import ModuleHeader from '../shared/ModuleHeader.jsx'

// Per-agent identity color — the propOG data-series ramp, taken in order
// (section 8.10: "Series colours in ramp order"), since this is exactly the
// "N categorical items need N distinct colors" case it exists for.
const AGENTS = [
  { initial:'D', name:'Drishti', role:'Project Intelligence', modules:'M1', status:'live', bg:'var(--pg-series-1)', stats:'23 projects · 184 summaries' },
  { initial:'P', name:'Prachar', role:'Campaign Engine', modules:'M2+M13', status:'live', bg:'var(--pg-series-2)', stats:'₹48L managed · 12 campaigns' },
  { initial:'R', name:'Rachna', role:'Creative Studio', modules:'M3', status:'live', bg:'var(--pg-series-3)', stats:'1,240 assets generated' },
  { initial:'A', name:'Aria', role:'Voice Qualification', modules:'M6', status:'live', bg:'var(--pg-series-4)', stats:'728 calls today · 92% connect' },
  { initial:'V', name:'Vaani', role:'WhatsApp Concierge', modules:'M7', status:'live', bg:'var(--pg-series-5)', stats:'2,140 messages today' },
  { initial:'Rk', name:'Rakshak', role:'Fraud Detection', modules:'M9', status:'live', bg:'var(--pg-series-6)', stats:'1,247 junk blocked' },
]

export default function AIWorkforce() {
  return (
    <div style={{ padding:'28px 32px', maxWidth:1280 }}>
      <ModuleHeader title="Your AI Workforce" subtitle="6 specialist agents collaborating across the funnel · All systems operational" />
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:18 }}>
        {AGENTS.map(a=>{
          const isDark = a.bg === 'var(--pg-series-1)' || a.bg === 'var(--pg-series-2)'
          const textOn = isDark ? 'var(--pg-on-dark)' : a.bg === 'var(--pg-series-4)' || a.bg === 'var(--pg-series-5)' ? 'var(--pg-on-gold)' : 'var(--pg-on-dark)'
          return (
          <div key={a.name} style={{ background:'var(--pg-surface)', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-3xl)', padding:'22px', position:'relative', overflow:'hidden' }}>
            <div style={{ position:'absolute', top:0, right:0, width:80, height:80, borderRadius:'0 16px 0 100%', background:`color-mix(in srgb, ${a.bg} 10%, transparent)` }} />
            <div style={{ display:'flex', gap:14, alignItems:'flex-start', marginBottom:16 }}>
              <div style={{ width:52, height:52, borderRadius:14, background:a.bg, display:'flex', alignItems:'center', justifyContent:'center', fontSize:a.initial.length>1?14:20, fontWeight:800, color:textOn, flexShrink:0 }}>{a.initial}</div>
              <div>
                <div style={{ fontWeight:800, fontSize:18, color:'var(--pg-ink)' }}>{a.name}</div>
                <div style={{ fontSize:12, color:'var(--pg-ink-2)' }}>{a.role}</div>
                <div style={{ fontSize:11, fontFamily:'var(--pg-font-mono)', color:'var(--pg-ink-3)', marginTop:2 }}>{a.modules}</div>
              </div>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
              <span style={{ width:8, height:8, borderRadius:'50%', background:'var(--pg-green)', display:'inline-block' }} />
              <span style={{ fontSize:11, fontWeight:700, color:'var(--pg-green)', fontFamily:'var(--pg-font-mono)' }}>LIVE</span>
            </div>
            <div style={{ fontSize:13, color:'var(--pg-ink)', fontWeight:600, background:'var(--pg-shell)', padding:'8px 12px', borderRadius:8 }}>{a.stats}</div>
            <div style={{ display:'flex', gap:8, marginTop:14 }}>
              <button style={{ flex:1, padding:'7px', border:'1px solid var(--pg-border)', borderRadius:8, background:'var(--pg-surface)', fontSize:12, cursor:'pointer', color:'var(--pg-ink-2)' }}>Configure</button>
              <button style={{ flex:1, padding:'7px', border:'none', borderRadius:8, background:'var(--pg-surface-dark)', fontSize:12, cursor:'pointer', color:'var(--pg-on-dark)', fontWeight:600 }}>View logs</button>
            </div>
          </div>
          )
        })}
      </div>
    </div>
  )
}

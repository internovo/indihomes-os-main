import React from 'react'
import Logomark from '../ui/Logomark.jsx'

const NAV_GROUPS = [
  { label: 'OVERVIEW', items: [
    { id: 'command', name: 'Command Center', mod: '01' },
  ]},
  { label: 'INTELLIGENCE', items: [
    { id: 'select', name: 'Project Selection', mod: '02' },
    { id: 'project', name: 'Project Intelligence', mod: '03' },
    { id: 'reco', name: 'Campaign Recommendations', mod: '04' },
  ]},
  { label: 'CREATIVE & DEPLOY', items: [
    { id: 'studio', name: 'Creative AI Studio', mod: '05' },
    { id: 'deploy', name: 'Campaign Deployment', mod: '06' },
  ]},
  { label: 'LEADS', items: [
    { id: 'capture', name: 'Lead Capture', mod: '07' },
    { id: 'scoring', name: 'Lead Scoring', mod: '08' },
    { id: 'junk', name: 'Junk Detection', mod: '09' },
  ]},
  { label: 'AI AGENTS', items: [
    { id: 'calling', name: 'AI Calling Agent', mod: '10' },
    { id: 'whatsapp', name: 'WhatsApp Agent', mod: '11' },
    { id: 'workforce', name: 'AI Workforce', mod: '12' },
  ]},
  { label: 'TEAM PERFORMANCE', items: [
    { id: 'callers', name: 'Caller Dashboard', mod: '13' },
  ]},
  { label: 'SALES', items: [
    { id: 'crm', name: 'Sales CRM', mod: '14' },
    { id: 'builder', name: 'Builder Collaboration', mod: '15' },
  ]},
  { label: 'REPORTS', items: [
    { id: 'analytics', name: 'AI Analytics', mod: '16' },
    { id: 'recommend', name: 'Recommendations', mod: '17' },
  ]},
  { label: 'ADMINISTRATION', items: [
    { id: 'users', name: 'User Management', mod: '18' },
  ]},
]

export default function Sidebar({ active, setView }) {
  return (
    <div style={{ width:220, flexShrink:0, background:'#0E0E52', overflowY:'auto', display:'flex', flexDirection:'column', height:'100vh', position:'sticky', top:0 }}>
      {/* Logo — a real mark (problem #9), not text-only. Logomark is pure SVG
          so it scales cleanly to an icon-only size if the sidebar ever gains
          a collapsed state; this pass only adds the mark, it doesn't add
          that toggle. */}
      <div style={{ padding:'20px 18px 16px', borderBottom:'1px solid rgba(255,255,255,0.08)', display:'flex', alignItems:'center', gap:10 }}>
        <Logomark size={32} />
        <div>
          <div style={{ fontSize:20, fontWeight:800, color:'#fff', letterSpacing:'-0.5px', lineHeight:1 }}>
            IndiHomes<span style={{ color:'#F7941D' }}> OS</span>
          </div>
          <div style={{ fontSize:10, color:'rgba(255,255,255,0.4)', fontFamily:"'IBM Plex Mono',monospace", marginTop:3, letterSpacing:'0.08em' }}>PLATFORM v2.6</div>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex:1, padding:'12px 0' }}>
        {NAV_GROUPS.map(g => (
          <div key={g.label} style={{ marginBottom:4 }}>
            <div style={{ padding:'8px 18px 4px', fontSize:9, fontFamily:"'IBM Plex Mono',monospace", color:'rgba(255,255,255,0.35)', letterSpacing:'0.14em', fontWeight:600 }}>{g.label}</div>
            {g.items.map(item => {
              const isActive = active === item.id
              return (
                <button
                  key={item.id}
                  onClick={() => setView(item.id)}
                  style={{
                    display:'flex', alignItems:'center', gap:8, width:'100%', padding:'7px 18px',
                    background: isActive ? '#fff' : 'transparent',
                    color: isActive ? '#0E0E52' : 'rgba(255,255,255,0.75)',
                    border:'none', cursor:'pointer', textAlign:'left', borderRadius:0,
                    fontFamily:"'Plus Jakarta Sans',sans-serif", fontSize:13, fontWeight: isActive ? 700 : 400,
                    transition:'all 0.15s',
                  }}
                  onMouseEnter={e => { if(!isActive) { e.currentTarget.style.background='rgba(255,255,255,0.08)'; e.currentTarget.style.color='#fff' } }}
                  onMouseLeave={e => { if(!isActive) { e.currentTarget.style.background='transparent'; e.currentTarget.style.color='rgba(255,255,255,0.75)' } }}
                >
                  <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, minWidth:22, color: isActive ? '#0E0E52' : 'rgba(255,255,255,0.35)', fontWeight:600 }}>{item.mod}</span>
                  <span style={{ flex:1, lineHeight:1.3 }}>{item.name}</span>
                </button>
              )
            })}
          </div>
        ))}
      </nav>

      {/* User */}
      <div style={{ padding:'14px 18px', borderTop:'1px solid rgba(255,255,255,0.08)', display:'flex', alignItems:'center', gap:10 }}>
        <div style={{ width:32, height:32, borderRadius:'50%', background:'#F7941D', display:'flex', alignItems:'center', justifyContent:'center', fontSize:13, fontWeight:700, color:'#fff', flexShrink:0 }}>A</div>
        <div>
          <div style={{ fontSize:12, fontWeight:600, color:'#fff' }}>Aarti Rawat</div>
          <div style={{ fontSize:10, color:'rgba(255,255,255,0.4)', fontFamily:"'IBM Plex Mono',monospace" }}>Super Admin</div>
        </div>
      </div>
    </div>
  )
}
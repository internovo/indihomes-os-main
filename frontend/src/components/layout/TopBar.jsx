import React, { useState } from 'react'

const LABELS = {
  command:'Command Center', select:'Project Selection', project:'Project Intelligence',
  reco:'Campaign Recommendations', studio:'Creative AI Studio', deploy:'Campaign Deployment',
  capture:'Lead Capture', scoring:'Lead Scoring', junk:'Junk Detection',
  calling:'AI Calling Agent', whatsapp:'WhatsApp Agent', workforce:'AI Workforce',
  callers:'Caller Dashboard', crm:'Sales CRM', builder:'Builder Collaboration',
  analytics:'AI Analytics', recommend:'AI Recommendations', users:'User Management',
}

export default function TopBar({ view, breadcrumbExtra }) {
  const [search, setSearch] = useState('')
  return (
    <div style={{ height:56, background:'#fff', borderBottom:'1px solid #E9E7E0', display:'flex', alignItems:'center', padding:'0 24px', gap:16, flexShrink:0, position:'sticky', top:0, zIndex:50 }}>
      <div style={{ flex:1 }}>
        <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#8A8896', letterSpacing:'0.06em' }}>
          IndiHomes OS / {LABELS[view] || view}{breadcrumbExtra ? ` / ${breadcrumbExtra}` : ''}
        </span>
      </div>
      <input
        value={search} onChange={e=>setSearch(e.target.value)}
        placeholder="Search projects, leads…"
        style={{ padding:'6px 14px', border:'1px solid #E9E7E0', borderRadius:8, fontSize:13, color:'#1B1B3A', outline:'none', width:220, fontFamily:"'Plus Jakarta Sans',sans-serif", background:'#F6F5F1' }}
      />
      <button style={{ background:'none', border:'none', cursor:'pointer', fontSize:20, padding:'0 4px', color:'#75737F' }} title="Notifications">🔔</button>
      <div style={{ width:32, height:32, borderRadius:'50%', background:'#0E0E52', display:'flex', alignItems:'center', justifyContent:'center', fontSize:13, fontWeight:700, color:'#fff', cursor:'pointer' }}>A</div>
      <div style={{ display:'flex', alignItems:'center', gap:6, padding:'4px 10px', border:'1px solid #E9E7E0', borderRadius:20, cursor:'pointer' }}>
        <span style={{ fontSize:11, color:'#75737F', fontWeight:500 }}>☀ Light</span>
      </div>
    </div>
  )
}
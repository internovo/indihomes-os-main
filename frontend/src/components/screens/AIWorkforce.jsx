import React from 'react'
import ModuleHeader from '../shared/ModuleHeader.jsx'

const AGENTS = [
  { initial:'D', name:'Drishti', role:'Project Intelligence', modules:'M1', status:'live', bg:'#8B8BD6', stats:'23 projects · 184 summaries' },
  { initial:'P', name:'Prachar', role:'Campaign Engine', modules:'M2+M13', status:'live', bg:'#F7941D', stats:'₹48L managed · 12 campaigns' },
  { initial:'R', name:'Rachna', role:'Creative Studio', modules:'M3', status:'live', bg:'#185FA5', stats:'1,240 assets generated' },
  { initial:'A', name:'Aria', role:'Voice Qualification', modules:'M6', status:'live', bg:'#2E9E4F', stats:'728 calls today · 92% connect' },
  { initial:'V', name:'Vaani', role:'WhatsApp Concierge', modules:'M7', status:'live', bg:'#0F766E', stats:'2,140 messages today' },
  { initial:'Rk', name:'Rakshak', role:'Fraud Detection', modules:'M9', status:'live', bg:'#D64545', stats:'1,247 junk blocked' },
]

export default function AIWorkforce() {
  return (
    <div style={{ padding:'28px 32px', maxWidth:1280 }}>
      <ModuleHeader title="Your AI Workforce" subtitle="6 specialist agents collaborating across the funnel · All systems operational" />
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:18 }}>
        {AGENTS.map(a=>(
          <div key={a.name} style={{ background:'#fff', border:'1px solid #E9E7E0', borderRadius:16, padding:'22px', position:'relative', overflow:'hidden' }}>
            <div style={{ position:'absolute', top:0, right:0, width:80, height:80, borderRadius:'0 16px 0 100%', background:`${a.bg}10` }} />
            <div style={{ display:'flex', gap:14, alignItems:'flex-start', marginBottom:16 }}>
              <div style={{ width:52, height:52, borderRadius:14, background:a.bg, display:'flex', alignItems:'center', justifyContent:'center', fontSize:a.initial.length>1?14:20, fontWeight:800, color:'#fff', flexShrink:0 }}>{a.initial}</div>
              <div>
                <div style={{ fontWeight:800, fontSize:18, color:'#1B1B3A' }}>{a.name}</div>
                <div style={{ fontSize:12, color:'#75737F' }}>{a.role}</div>
                <div style={{ fontSize:11, fontFamily:"'IBM Plex Mono',monospace", color:'#8A8896', marginTop:2 }}>{a.modules}</div>
              </div>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
              <span style={{ width:8, height:8, borderRadius:'50%', background:'#2E9E4F', display:'inline-block' }} />
              <span style={{ fontSize:11, fontWeight:700, color:'#2E9E4F', fontFamily:"'IBM Plex Mono',monospace" }}>LIVE</span>
            </div>
            <div style={{ fontSize:13, color:'#1B1B3A', fontWeight:600, background:'#F6F5F1', padding:'8px 12px', borderRadius:8 }}>{a.stats}</div>
            <div style={{ display:'flex', gap:8, marginTop:14 }}>
              <button style={{ flex:1, padding:'7px', border:'1px solid #E9E7E0', borderRadius:8, background:'#fff', fontSize:12, cursor:'pointer', color:'#75737F' }}>Configure</button>
              <button style={{ flex:1, padding:'7px', border:'none', borderRadius:8, background:'#0E0E52', fontSize:12, cursor:'pointer', color:'#fff', fontWeight:600 }}>View logs</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
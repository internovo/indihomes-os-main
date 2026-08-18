import React, { useState } from 'react'
import ModuleHeader from '../shared/ModuleHeader.jsx'

const RECOS = [
  { priority:1, badge:'#1 PRIORITY', project:'Lodha Amara — 3 BHK · ₹1.95 Cr', reason:'118 unsold units with high demand velocity. 34% rise in portal search. Competition re-entering Thane.', cpl:'₹380', delta:'-40% vs avg', gain:'est. 340 leads / month' },
  { priority:2, badge:'#2 PRIORITY', project:'Reactivate Kalpataru Vista', reason:'Campaign paused 18 days. 279 unsold units. Builder requesting push before Q3 close.', cpl:'₹290', delta:'-54% vs avg', gain:'est. 210 leads / month' },
  { priority:3, badge:'#3 PRIORITY', project:'Expand Godrej Hillside to YouTube', reason:'Google Search CPL spiking. YouTube pre-roll shows 60% lower CPL in A/B test for this segment.', cpl:'₹1,240', delta:'-42% vs current', gain:'est. 80 leads / month' },
]

const CHANNELS = [
  { name:'Meta Reels', spend:'₹14.2L', cpl:'₹318', leads:4470, trend:'+18%', color:'#1877F2' },
  { name:'Google Search', spend:'₹9.8L', cpl:'₹842', leads:1163, trend:'-12%', color:'#EA4335' },
  { name:'99acres', spend:'₹3.2L', cpl:'₹580', leads:552, trend:'+4%', color:'#E06B00' },
  { name:'Housing.com', spend:'₹2.4L', cpl:'₹640', leads:375, trend:'+2%', color:'#7C3AED' },
  { name:'YouTube', spend:'₹4.1L', cpl:'₹920', leads:446, trend:'+8%', color:'#FF0000' },
  { name:'MagicBricks', spend:'₹1.8L', cpl:'₹720', leads:250, trend:'-3%', color:'#0F766E' },
]

export default function CampaignRecommendations() {
  const [dismissed, setDismissed] = useState([])
  const [launched, setLaunched] = useState([])
  return (
    <div style={{ padding:'28px 32px', maxWidth:1280 }}>
      <ModuleHeader module="MODULE 04" title="Campaign Recommendations"
        subtitle="Prachar analysed inventory velocity, demand signals & channel performance to surface these opportunities"
      />
      <div style={{ display:'flex', flexDirection:'column', gap:14, marginBottom:32 }}>
        {RECOS.map(r=>{
          const isDismissed = dismissed.includes(r.priority)
          const isLaunched = launched.includes(r.priority)
          return (
            <div key={r.priority} style={{ background:'#fff', border:'1px solid #E9E7E0', borderLeft:'4px solid #D64545', borderRadius:12, padding:'20px 24px', opacity:isDismissed?0.4:1, transition:'opacity 0.2s' }}>
              <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:16 }}>
                <div style={{ flex:1 }}>
                  <div style={{ display:'flex', gap:10, alignItems:'center', marginBottom:8 }}>
                    <span style={{ background:'#D64545', color:'#fff', padding:'3px 10px', borderRadius:4, fontSize:11, fontWeight:700, fontFamily:"'IBM Plex Mono',monospace" }}>{r.badge}</span>
                    <span style={{ fontSize:15, fontWeight:700, color:'#1B1B3A' }}>{r.project}</span>
                  </div>
                  <p style={{ fontSize:13, color:'#75737F', lineHeight:1.6, marginBottom:12 }}>{r.reason}</p>
                  <div style={{ display:'flex', gap:16 }}>
                    <div><div style={{ fontSize:11, color:'#8A8896', fontFamily:"'IBM Plex Mono',monospace" }}>PROJECTED CPL</div><div style={{ fontSize:18, fontWeight:800, color:'#2E9E4F' }}>{r.cpl} <span style={{ fontSize:12, color:'#2E9E4F' }}>{r.delta}</span></div></div>
                    <div><div style={{ fontSize:11, color:'#8A8896', fontFamily:"'IBM Plex Mono',monospace" }}>ESTIMATED GAIN</div><div style={{ fontSize:14, fontWeight:600, color:'#1B1B3A', marginTop:2 }}>{r.gain}</div></div>
                  </div>
                </div>
                <div style={{ display:'flex', flexDirection:'column', gap:8, flexShrink:0 }}>
                  {isLaunched
                    ? <span style={{ background:'#E8F7EE', color:'#2E9E4F', padding:'8px 18px', borderRadius:8, fontSize:13, fontWeight:700 }}>✓ Launched</span>
                    : <button onClick={()=>setLaunched(l=>[...l,r.priority])} style={{ padding:'8px 18px', background:'#0E0E52', color:'#fff', border:'none', borderRadius:8, fontSize:13, fontWeight:600, cursor:'pointer' }}>Launch campaign</button>
                  }
                  {!isDismissed && !isLaunched && <button onClick={()=>setDismissed(d=>[...d,r.priority])} style={{ padding:'8px 18px', background:'#fff', color:'#75737F', border:'1px solid #E9E7E0', borderRadius:8, fontSize:13, cursor:'pointer' }}>Dismiss</button>}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      {/* Channel Performance */}
      <h3 style={{ fontSize:16, fontWeight:700, marginBottom:14, color:'#1B1B3A' }}>Channel Performance Overview</h3>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:14 }}>
        {CHANNELS.map(ch=>(
          <div key={ch.name} style={{ background:'#fff', border:'1px solid #E9E7E0', borderRadius:12, padding:'16px 18px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
              <div style={{ width:10, height:10, borderRadius:'50%', background:ch.color }} />
              <span style={{ fontWeight:700, fontSize:14 }}>{ch.name}</span>
              <span style={{ marginLeft:'auto', fontSize:12, fontWeight:600, color:ch.trend.startsWith('+')?'#2E9E4F':'#D64545' }}>{ch.trend}</span>
            </div>
            {[['Spend',ch.spend],['CPL',ch.cpl],['Leads',ch.leads.toLocaleString()]].map(([l,v])=>(
              <div key={l} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', fontSize:12 }}>
                <span style={{ color:'#75737F' }}>{l}</span><span style={{ fontWeight:600, fontFamily:"'IBM Plex Mono',monospace" }}>{v}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
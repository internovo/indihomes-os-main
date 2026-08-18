import React, { useState } from 'react'
import ModuleHeader from '../shared/ModuleHeader.jsx'

const RECS = [
  { id:1, badge:'STOP CAMPAIGN', badgeColor:'#D64545', title:'Pause Godrej Hillside 2BHK Google Search', desc:'CPL at ₹2,140 — 38% over target. No conversion uplift in last 14 days despite 3 creative refreshes. Recommended: Reallocate budget to Meta Reels.', gain:'Save ₹3.2L', gainColor:'#2E9E4F', gainBg:'#E8F7EE' },
  { id:2, badge:'SHIFT BUDGET', badgeColor:'#F7941D', title:'Move ₹2.4L from 99acres to Meta Reels', desc:'99acres CPL trending up 22% while Meta Reels continues to outperform at ₹318 CPL. Rebalancing will yield estimated +340 leads at same cost.', gain:'Earn ₹1.8L equiv.', gainColor:'#F7941D', gainBg:'#FEF3E4' },
  { id:3, badge:'NEW AUDIENCE', badgeColor:'#185FA5', title:'Launch upgrade-buyer segment for Lodha 3BHK', desc:'Drishti identified 2.4L Mumbai HNI audience (30-45, finance sector) showing high affinity for Thane townships. Estimated 340 new leads at ₹290 CPL.', gain:'+340 leads', gainColor:'#185FA5', gainBg:'#EBF3FD' },
  { id:4, badge:'CREATIVE REFRESH', badgeColor:'#8B8BD6', title:'Replace top 3 Meta creatives for Kalpataru Vista', desc:'Creative fatigue detected — frequency at 4.8× and CTR declining 18% week-over-week. Rachna has pre-generated 6 new creatives ready for A/B test.', gain:'+12% CTR', gainColor:'#8B8BD6', gainBg:'#F0EEF8' },
  { id:5, badge:'LAUNCH CAMPAIGN', badgeColor:'#2E9E4F', title:'Activate Panvel campaign for Hiranandani Parks', desc:'Panvel micro-market showing 41% YoY growth in search interest. 85-acre township with upcoming metro connectivity — ideal launch window Q3 2026.', gain:'280 leads est.', gainColor:'#2E9E4F', gainBg:'#E8F7EE' },
  { id:6, badge:'REDUCE BID', badgeColor:'#F7941D', title:'Lower Google max CPC from ₹180 to ₹140', desc:'Auction intelligence shows ₹140 CPC wins 89% of impressions — same as ₹180. Immediate 22% budget saving with no reach impact.', gain:'Save ₹0.8L', gainColor:'#2E9E4F', gainBg:'#E8F7EE' },
]

export default function AIRecommendations() {
  const [approved, setApproved] = useState([])
  const [dismissed, setDismissed] = useState([])
  return (
    <div style={{ padding:'28px 32px', maxWidth:1280 }}>
      <ModuleHeader module="MODULE 17" title="Actionable Recommendations"
        subtitle={`Approve to let the workforce execute · ${RECS.length - approved.length - dismissed.length} open actions`}
      />
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        {RECS.map(r=>{
          const isApproved = approved.includes(r.id)
          const isDismissed = dismissed.includes(r.id)
          return (
            <div key={r.id} style={{ background:'#fff', border:'1px solid #E9E7E0', borderRadius:14, padding:'20px', opacity:isDismissed?0.4:1, transition:'opacity 0.2s', position:'relative' }}>
              {isApproved && (
                <div style={{ position:'absolute', top:0, right:0, background:'#2E9E4F', color:'#fff', fontSize:12, fontWeight:700, padding:'4px 14px', borderRadius:'0 14px 0 10px' }}>✓ Approved</div>
              )}
              <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:10 }}>
                <span style={{ background:`${r.badgeColor}18`, color:r.badgeColor, padding:'3px 9px', borderRadius:4, fontSize:10, fontWeight:700, fontFamily:"'IBM Plex Mono',monospace" }}>{r.badge}</span>
                <span style={{ background:r.gainBg, color:r.gainColor, padding:'3px 9px', borderRadius:4, fontSize:11, fontWeight:700, marginLeft:'auto' }}>{r.gain}</span>
              </div>
              <div style={{ fontWeight:700, fontSize:14, marginBottom:6, color:'#1B1B3A' }}>{r.title}</div>
              <p style={{ fontSize:13, color:'#75737F', lineHeight:1.6, marginBottom:14 }}>{r.desc}</p>
              {!isApproved && !isDismissed && (
                <div style={{ display:'flex', gap:8 }}>
                  <button onClick={()=>setApproved(a=>[...a,r.id])} style={{ flex:1, padding:'8px', background:'#0E0E52', color:'#fff', border:'none', borderRadius:8, fontSize:13, fontWeight:600, cursor:'pointer' }}>✓ Approve</button>
                  <button onClick={()=>setDismissed(d=>[...d,r.id])} style={{ flex:1, padding:'8px', background:'#fff', color:'#75737F', border:'1px solid #E9E7E0', borderRadius:8, fontSize:13, cursor:'pointer' }}>Dismiss</button>
                </div>
              )}
              {isApproved && <div style={{ fontSize:12, color:'#2E9E4F', fontWeight:600, textAlign:'center' }}>Workforce is executing this action...</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
import React, { useState } from 'react'
import ModuleHeader from '../shared/ModuleHeader.jsx'

const RECS = [
  { id:1, badge:'STOP CAMPAIGN', badgeColor:'var(--pg-red)', title:'Pause Godrej Hillside 2BHK Google Search', desc:'CPL at ₹2,140 — 38% over target. No conversion uplift in last 14 days despite 3 creative refreshes. Recommended: Reallocate budget to Meta Reels.', gain:'Save ₹3.2L', gainColor:'var(--pg-green)', gainBg:'var(--pg-tint-green)' },
  { id:2, badge:'SHIFT BUDGET', badgeColor:'var(--pg-gold)', title:'Move ₹2.4L from 99acres to Meta Reels', desc:'99acres CPL trending up 22% while Meta Reels continues to outperform at ₹318 CPL. Rebalancing will yield estimated +340 leads at same cost.', gain:'Earn ₹1.8L equiv.', gainColor:'var(--pg-gold-deep)', gainBg:'var(--pg-tint-amber)' },
  { id:3, badge:'NEW AUDIENCE', badgeColor:'var(--pg-indigo)', title:'Launch upgrade-buyer segment for Lodha 3BHK', desc:'Drishti identified 2.4L Mumbai HNI audience (30-45, finance sector) showing high affinity for Thane townships. Estimated 340 new leads at ₹290 CPL.', gain:'+340 leads', gainColor:'var(--pg-indigo)', gainBg:'var(--pg-tint-indigo)' },
  { id:4, badge:'CREATIVE REFRESH', badgeColor:'var(--pg-indigo-light)', title:'Replace top 3 Meta creatives for Kalpataru Vista', desc:'Creative fatigue detected — frequency at 4.8× and CTR declining 18% week-over-week. Rachna has pre-generated 6 new creatives ready for A/B test.', gain:'+12% CTR', gainColor:'var(--pg-indigo-light)', gainBg:'var(--pg-tint-indigo-2)' },
  { id:5, badge:'LAUNCH CAMPAIGN', badgeColor:'var(--pg-green)', title:'Activate Panvel campaign for Hiranandani Parks', desc:'Panvel micro-market showing 41% YoY growth in search interest. 85-acre township with upcoming metro connectivity — ideal launch window Q3 2026.', gain:'280 leads est.', gainColor:'var(--pg-green)', gainBg:'var(--pg-tint-green)' },
  { id:6, badge:'REDUCE BID', badgeColor:'var(--pg-gold)', title:'Lower Google max CPC from ₹180 to ₹140', desc:'Auction intelligence shows ₹140 CPC wins 89% of impressions — same as ₹180. Immediate 22% budget saving with no reach impact.', gain:'Save ₹0.8L', gainColor:'var(--pg-green)', gainBg:'var(--pg-tint-green)' },
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
            <div key={r.id} style={{ background:'var(--pg-surface)', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-2xl)', padding:'20px', opacity:isDismissed?0.4:1, transition:'opacity 0.2s', position:'relative' }}>
              {isApproved && (
                <div style={{ position:'absolute', top:0, right:0, background:'var(--pg-green)', color:'var(--pg-on-dark)', fontSize:12, fontWeight:700, padding:'4px 14px', borderRadius:'0 14px 0 10px' }}>✓ Approved</div>
              )}
              <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:10 }}>
                <span style={{ background:`color-mix(in srgb, ${r.badgeColor} 15%, transparent)`, color:r.badgeColor, padding:'3px 9px', borderRadius:'var(--pg-r-sm)', fontSize:10, fontWeight:700, fontFamily:'var(--pg-font-mono)' }}>{r.badge}</span>
                <span style={{ background:r.gainBg, color:r.gainColor, padding:'3px 9px', borderRadius:'var(--pg-r-sm)', fontSize:11, fontWeight:700, marginLeft:'auto' }}>{r.gain}</span>
              </div>
              <div style={{ fontWeight:700, fontSize:14, marginBottom:6, color:'var(--pg-ink)' }}>{r.title}</div>
              <p style={{ fontSize:13, color:'var(--pg-ink-2)', lineHeight:1.6, marginBottom:14 }}>{r.desc}</p>
              {!isApproved && !isDismissed && (
                <div style={{ display:'flex', gap:8 }}>
                  <button onClick={()=>setApproved(a=>[...a,r.id])} style={{ flex:1, padding:'8px', background:'var(--pg-surface-dark)', color:'var(--pg-on-dark)', border:'none', borderRadius:'var(--pg-r-md)', fontSize:13, fontWeight:600, cursor:'pointer' }}>✓ Approve</button>
                  <button onClick={()=>setDismissed(d=>[...d,r.id])} style={{ flex:1, padding:'8px', background:'var(--pg-surface)', color:'var(--pg-ink-2)', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-md)', fontSize:13, cursor:'pointer' }}>Dismiss</button>
                </div>
              )}
              {isApproved && <div style={{ fontSize:12, color:'var(--pg-green)', fontWeight:600, textAlign:'center' }}>Workforce is executing this action...</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

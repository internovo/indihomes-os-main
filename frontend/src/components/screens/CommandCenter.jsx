import React from 'react'
import StatCard from '../shared/StatCard.jsx'
import { CAMPAIGNS } from '../../data/campaigns.js'

const btn = (bg, color) => ({ padding:'9px 18px', background:bg, color, border:'none', borderRadius:8, fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:"'Plus Jakarta Sans',sans-serif" })

const statusBadge = (s) => {
  const map = { live:['#2E9E4F','#E8F7EE','🟢 Live'], alert:['#D64545','#FDEAEA','🔴 Alert'], paused:['#F7941D','#FEF3E4','🟡 Paused'] }
  const [c, bg, label] = map[s] || ['#75737F','#F0EEEB','—']
  return <span style={{ background:bg, color:c, padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:600, fontFamily:"'IBM Plex Mono',monospace" }}>{label}</span>
}

export default function CommandCenter() {
  return (
    <div style={{ padding:'28px 32px', maxWidth:1280 }}>
      {/* Header */}
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:20 }}>
        <div>
          <h1 style={{ fontSize:28, fontWeight:800, color:'#1B1B3A' }}>Good morning, Aarti 👋</h1>
          <p style={{ fontSize:13, color:'#75737F', marginTop:4 }}>Tuesday, 23 June 2026 · Portfolio across 7 builders · 23 live projects</p>
        </div>
        <div style={{ display:'flex', gap:10 }}>
          <button style={btn('#fff','#1B1B3A')}>⬇ Export report</button>
          <button style={{ ...btn('#FECF55','#0E0E52'), border:'none' }}>＋ New campaign</button>
        </div>
      </div>

      {/* AI Digest */}
      <div style={{ background:'linear-gradient(135deg,#0E0E52 0%,#1a1a7a 100%)', borderRadius:14, padding:'20px 24px', marginBottom:24, display:'flex', gap:18, alignItems:'flex-start' }}>
        <div style={{ width:40, height:40, borderRadius:'50%', background:'#F7941D', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, flexShrink:0 }}>✦</div>
        <div>
          <div style={{ fontSize:13, color:'rgba(255,255,255,0.5)', fontFamily:"'IBM Plex Mono',monospace", marginBottom:6, letterSpacing:'0.05em' }}>DRISHTI AI DIGEST · TUESDAY 23 JUNE</div>
          <p style={{ color:'#fff', fontSize:14, lineHeight:1.6, marginBottom:8 }}>
            <strong>Portfolio up 18% MoM</strong> — Lodha Amara is your star performer with 1,321 leads and ₹318 CPL (40% below target). 
            6,140 total leads captured across 23 campaigns with <strong>218 bookings</strong> this month.
          </p>
          <div style={{ background:'rgba(214,69,69,0.2)', border:'1px solid rgba(214,69,69,0.4)', borderRadius:8, padding:'8px 14px', display:'inline-flex', alignItems:'center', gap:8 }}>
            <span style={{ fontSize:14 }}>⚠️</span>
            <span style={{ color:'#ff9999', fontSize:13 }}>Godrej Hillside CPL at ₹2,140 — 38% over target. Review campaign targeting.</span>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:16, marginBottom:28 }}>
        <StatCard label="Total Spend MTD" value="₹1.24 Cr" trend="▲ 18% MoM" trendDir="up" accent="#0E0E52" />
        <StatCard label="Leads Generated" value="12,480" trend="▲ 22% WoW" trendDir="up" accent="#2E9E4F" />
        <StatCard label="Site Visits" value="1,847" trend="▲ 9% MoM" trendDir="up" accent="#F7941D" />
        <StatCard label="Bookings" value="218" trend="▲ 31% MoM" trendDir="up" accent="#8B8BD6" />
      </div>

      {/* Active Campaigns */}
      <div style={{ background:'#fff', border:'1px solid #E9E7E0', borderRadius:12, overflow:'hidden' }}>
        <div style={{ padding:'16px 24px', borderBottom:'1px solid #E9E7E0', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div style={{ fontSize:16, fontWeight:700, color:'#1B1B3A' }}>Active Campaigns</div>
          <span style={{ fontSize:12, color:'#75737F' }}>6 campaigns running</span>
        </div>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ background:'#F6F5F1' }}>
              {['Project','Channel','Status','Budget','CPL','Leads','Action'].map(h=>(
                <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontSize:11, color:'#8A8896', fontWeight:600, letterSpacing:'0.05em', textTransform:'uppercase', fontFamily:"'IBM Plex Mono',monospace" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CAMPAIGNS.map((c,i)=>(
              <tr key={c.id} style={{ borderTop:'1px solid #E9E7E0', background: i%2===0?'#fff':'#fafaf8' }}>
                <td style={{ padding:'12px 16px', fontWeight:600, fontSize:13 }}>{c.project}</td>
                <td style={{ padding:'12px 16px', fontSize:13, color:'#75737F' }}>{c.channel}</td>
                <td style={{ padding:'12px 16px' }}>{statusBadge(c.status)}</td>
                <td style={{ padding:'12px 16px', fontSize:13, fontFamily:"'IBM Plex Mono',monospace" }}>{c.budget}</td>
                <td style={{ padding:'12px 16px', fontSize:13, fontFamily:"'IBM Plex Mono',monospace", color: c.status==='alert'?'#D64545':'#1B1B3A' }}>{c.cpl}</td>
                <td style={{ padding:'12px 16px', fontSize:13, fontWeight:600 }}>{c.leads.toLocaleString()}</td>
                <td style={{ padding:'12px 16px' }}>
                  <button style={{ padding:'5px 14px', borderRadius:6, border:'1px solid #E9E7E0', background:'#fff', fontSize:12, fontWeight:600, cursor:'pointer', color: c.status==='alert'?'#D64545': c.status==='paused'?'#2E9E4F':'#75737F' }}>
                    {c.status==='live'?'Pause': c.status==='alert'?'Review':'Resume'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
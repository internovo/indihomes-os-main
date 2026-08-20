import React from 'react'
import StatCard from '../shared/StatCard.jsx'
import { CAMPAIGNS } from '../../data/campaigns.js'

const btn = (bg, color) => ({ padding:'9px 18px', background:bg, color, border:'none', borderRadius:'var(--pg-r-md)', fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:'var(--pg-font)' })

const statusBadge = (s) => {
  const map = { live:['var(--pg-green)','var(--pg-tint-green)','🟢 Live'], alert:['var(--pg-red)','var(--pg-tint-red)','🔴 Alert'], paused:['var(--pg-gold)','var(--pg-tint-amber)','🟡 Paused'] }
  const [c, bg, label] = map[s] || ['var(--pg-ink-2)','var(--pg-shell)','—']
  return <span style={{ background:bg, color:c, padding:'3px 10px', borderRadius:'var(--pg-r-md)', fontSize:11, fontWeight:600, fontFamily:'var(--pg-font-mono)' }}>{label}</span>
}

export default function CommandCenter() {
  return (
    <div style={{ padding:'28px 32px', maxWidth:1280 }}>
      {/* Header */}
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:20 }}>
        <div>
          <h1 style={{ fontSize:25, fontWeight:800, color:'var(--pg-ink)', letterSpacing:'-0.5px' }}>Good morning, Aarti 👋</h1>
          <p style={{ fontSize:13, color:'var(--pg-ink-2)', marginTop:4 }}>Tuesday, 23 June 2026 · Portfolio across 7 builders · 23 live projects</p>
        </div>
        <div style={{ display:'flex', gap:10 }}>
          <button style={btn('var(--pg-surface)','var(--pg-ink)')}>⬇ Export report</button>
          <button style={{ ...btn('var(--pg-gold)','var(--pg-on-gold)'), border:'none' }}>＋ New campaign</button>
        </div>
      </div>

      {/* AI Digest */}
      <div style={{ background:'linear-gradient(100deg, var(--pg-surface-dark) 0%, var(--pg-surface-dark-2) 100%)', borderRadius:'var(--pg-r-2xl)', padding:'20px 24px', marginBottom:24, display:'flex', gap:18, alignItems:'flex-start' }}>
        <div style={{ width:40, height:40, borderRadius:'50%', background:'var(--pg-gold)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, flexShrink:0 }}>✦</div>
        <div>
          <div style={{ fontSize:10.5, color:'rgba(255,255,255,0.5)', fontFamily:'var(--pg-font-mono)', marginBottom:6, letterSpacing:'1px' }}>DRISHTI AI DIGEST · TUESDAY 23 JUNE</div>
          <p style={{ color:'#fff', fontSize:14, lineHeight:1.6, marginBottom:8 }}>
            <strong>Portfolio up 18% MoM</strong> — Lodha Amara is your star performer with 1,321 leads and ₹318 CPL (40% below target).
            6,140 total leads captured across 23 campaigns with <strong>218 bookings</strong> this month.
          </p>
          <div style={{ background:'rgba(214,69,69,0.2)', border:'1px solid rgba(214,69,69,0.4)', borderRadius:'var(--pg-r-md)', padding:'8px 14px', display:'inline-flex', alignItems:'center', gap:8 }}>
            <span style={{ fontSize:14 }}>⚠️</span>
            <span style={{ color:'var(--pg-red)', fontSize:13 }}>Godrej Hillside CPL at ₹2,140 — 38% over target. Review campaign targeting.</span>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:16, marginBottom:28 }}>
        <StatCard label="Total Spend MTD" value="₹1.24 Cr" trend="▲ 18% MoM" trendDir="up" accent="var(--pg-surface-dark)" />
        <StatCard label="Leads Generated" value="12,480" trend="▲ 22% WoW" trendDir="up" accent="var(--pg-green)" />
        <StatCard label="Site Visits" value="1,847" trend="▲ 9% MoM" trendDir="up" accent="var(--pg-gold)" />
        <StatCard label="Bookings" value="218" trend="▲ 31% MoM" trendDir="up" accent="var(--pg-indigo-light)" />
      </div>

      {/* Active Campaigns */}
      <div style={{ background:'var(--pg-surface)', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-xl)', overflow:'hidden' }}>
        <div style={{ padding:'16px 24px', borderBottom:'1px solid var(--pg-border)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div style={{ fontSize:13.5, fontWeight:700, color:'var(--pg-ink)' }}>Active Campaigns</div>
          <span style={{ fontSize:12, color:'var(--pg-ink-2)' }}>6 campaigns running</span>
        </div>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ background:'var(--pg-shell)' }}>
              {['Project','Channel','Status','Budget','CPL','Leads','Action'].map(h=>(
                <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontSize:11.5, color:'var(--pg-ink-3)', fontWeight:600, letterSpacing:'0.05em', textTransform:'uppercase', fontFamily:'var(--pg-font)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CAMPAIGNS.map((c,i)=>(
              <tr key={c.id} style={{ borderTop:'1px solid var(--pg-border)', background: i%2===0?'var(--pg-surface)':'var(--pg-shell)' }}>
                <td style={{ padding:'12px 16px', fontWeight:600, fontSize:13 }}>{c.project}</td>
                <td style={{ padding:'12px 16px', fontSize:13, color:'var(--pg-ink-2)' }}>{c.channel}</td>
                <td style={{ padding:'12px 16px' }}>{statusBadge(c.status)}</td>
                <td style={{ padding:'12px 16px', fontSize:13, fontFamily:'var(--pg-font-mono)' }}>{c.budget}</td>
                <td style={{ padding:'12px 16px', fontSize:13, fontFamily:'var(--pg-font-mono)', color: c.status==='alert'?'var(--pg-red)':'var(--pg-ink)' }}>{c.cpl}</td>
                <td style={{ padding:'12px 16px', fontSize:13, fontWeight:600 }}>{c.leads.toLocaleString()}</td>
                <td style={{ padding:'12px 16px' }}>
                  <button style={{ padding:'5px 14px', borderRadius:'var(--pg-r-sm)', border:'1px solid var(--pg-border)', background:'var(--pg-surface)', fontSize:12, fontWeight:600, cursor:'pointer', color: c.status==='alert'?'var(--pg-red)': c.status==='paused'?'var(--pg-green)':'var(--pg-ink-2)' }}>
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

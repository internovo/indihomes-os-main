import React from 'react'
import ModuleHeader from '../shared/ModuleHeader.jsx'
import StatCard from '../shared/StatCard.jsx'

const CHANNELS = [
  { name:'Meta Reels', spend:'₹14.2L', cpl:'₹318', leads:4470, visits:820, roi:'8.2×', color:'var(--pg-series-1)' },
  { name:'Google Search', spend:'₹9.8L', cpl:'₹842', leads:1163, visits:201, roi:'4.1×', color:'var(--pg-series-2)' },
  { name:'99acres', spend:'₹3.2L', cpl:'₹580', leads:552, visits:88, roi:'5.5×', color:'var(--pg-series-3)' },
  { name:'MagicBricks', spend:'₹1.8L', cpl:'₹720', leads:250, visits:36, roi:'4.8×', color:'var(--pg-series-4)' },
  { name:'Housing.com', spend:'₹2.4L', cpl:'₹640', leads:375, visits:62, roi:'5.2×', color:'var(--pg-series-5)' },
  { name:'YouTube', spend:'₹4.1L', cpl:'₹920', leads:446, visits:98, roi:'4.9×', color:'var(--pg-series-6)' },
]

const CREATIVES = [
  { name:'Lodha Amara · 3BHK Lifestyle Reel', channel:'Meta', impressions:'1.24M', ctr:'4.2%', leads:892, status:'Top performer' },
  { name:'Godrej Hillside · 2BHK Affordability', channel:'Google', impressions:'342K', ctr:'1.8%', leads:184, status:'Underperforming' },
  { name:'Kalpataru Vista · Nature Living', channel:'Meta', impressions:'680K', ctr:'3.4%', leads:521, status:'Good' },
  { name:'Piramal Vaikunth · Township Life', channel:'YouTube', impressions:'920K', ctr:'2.1%', leads:198, status:'Good' },
]

export default function AIAnalytics() {
  return (
    <div style={{ padding:'28px 32px', maxWidth:1280 }}>
      <ModuleHeader module="MODULE 16" title="Performance Analytics"
        rightContent={<button style={{ padding:'8px 16px', background:'var(--pg-gold)', color:'var(--pg-on-gold)', border:'none', borderRadius:'var(--pg-r-md)', fontSize:13, fontWeight:700, cursor:'pointer' }}>⬇ Export report</button>}
      />
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:14, marginBottom:28 }}>
        <StatCard label="Cost Per Lead" value="₹442" trend="▼ 8% vs last month" trendDir="down" accent="var(--pg-green)" />
        <StatCard label="Cost Per Visit" value="₹2,860" trend="▼ 5% vs last month" trendDir="down" accent="var(--pg-surface-dark)" />
        <StatCard label="Cost Per Booking" value="₹46K" trend="▲ 3% vs last month" trendDir="up" accent="var(--pg-gold)" />
        <StatCard label="Blended ROI" value="6.4×" trend="▲ Portfolio average" trendDir="up" accent="var(--pg-indigo-light)" />
      </div>
      {/* Channel table */}
      <div style={{ background:'var(--pg-surface)', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-xl)', overflow:'hidden', marginBottom:20 }}>
        <div style={{ padding:'14px 20px', borderBottom:'1px solid var(--pg-border)', fontWeight:700, fontSize:15 }}>Channel Performance</div>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ background:'var(--pg-shell)' }}>
              {['Channel','Spend','CPL','Leads','Visits','ROI'].map(h=>(
                <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontSize:11.5, color:'var(--pg-ink-3)', fontWeight:600, letterSpacing:'0.05em', textTransform:'uppercase', fontFamily:'var(--pg-font)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CHANNELS.map((c,i)=>(
              <tr key={c.name} style={{ borderTop:'1px solid var(--pg-border)', background:i%2===0?'var(--pg-surface)':'var(--pg-shell)' }}>
                <td style={{ padding:'12px 16px' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <div style={{ width:10, height:10, borderRadius:'50%', background:c.color }} />
                    <span style={{ fontWeight:600, fontSize:13 }}>{c.name}</span>
                  </div>
                </td>
                <td style={{ padding:'12px 16px', fontSize:13, fontFamily:'var(--pg-font-mono)' }}>{c.spend}</td>
                <td style={{ padding:'12px 16px', fontSize:13, fontFamily:'var(--pg-font-mono)' }}>{c.cpl}</td>
                <td style={{ padding:'12px 16px', fontSize:13, fontWeight:600 }}>{c.leads.toLocaleString()}</td>
                <td style={{ padding:'12px 16px', fontSize:13 }}>{c.visits}</td>
                <td style={{ padding:'12px 16px', fontSize:13, fontWeight:700, color:'var(--pg-green)' }}>{c.roi}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Top creatives */}
      <div style={{ background:'var(--pg-surface)', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-xl)', overflow:'hidden' }}>
        <div style={{ padding:'14px 20px', borderBottom:'1px solid var(--pg-border)', fontWeight:700, fontSize:15 }}>Top Performing Creatives</div>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ background:'var(--pg-shell)' }}>
              {['Creative','Channel','Impressions','CTR','Leads','Status'].map(h=>(
                <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontSize:11.5, color:'var(--pg-ink-3)', fontWeight:600, letterSpacing:'0.05em', textTransform:'uppercase', fontFamily:'var(--pg-font)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CREATIVES.map((c,i)=>(
              <tr key={i} style={{ borderTop:'1px solid var(--pg-border)' }}>
                <td style={{ padding:'12px 16px', fontWeight:600, fontSize:13 }}>{c.name}</td>
                <td style={{ padding:'12px 16px', fontSize:13 }}>{c.channel}</td>
                <td style={{ padding:'12px 16px', fontSize:13, fontFamily:'var(--pg-font-mono)' }}>{c.impressions}</td>
                <td style={{ padding:'12px 16px', fontSize:13, fontWeight:700 }}>{c.ctr}</td>
                <td style={{ padding:'12px 16px', fontSize:13, fontWeight:600 }}>{c.leads}</td>
                <td style={{ padding:'12px 16px' }}>
                  <span style={{ background:c.status==='Top performer'?'var(--pg-tint-green)':c.status==='Underperforming'?'var(--pg-tint-red)':'var(--pg-tint-amber)', color:c.status==='Top performer'?'var(--pg-green)':c.status==='Underperforming'?'var(--pg-red)':'var(--pg-gold-deep)', padding:'3px 9px', borderRadius:'var(--pg-r-md)', fontSize:11, fontWeight:600 }}>{c.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

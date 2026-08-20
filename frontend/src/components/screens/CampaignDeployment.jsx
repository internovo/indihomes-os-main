import React from 'react'
import ModuleHeader from '../shared/ModuleHeader.jsx'

// External channel identity colors — real brand marks (Meta/Google/YouTube/
// Housing.com/99acres/MagicBricks), not part of the propOG palette. Left as
// literal hex deliberately: forcing a channel's own brand color onto our
// tokens would misrepresent which service a dot/badge refers to.
const CHANNELS = [
  { name:'Meta Ads', status:'live', color:'#1877F2', spend:'₹14.2L', leads:4470 },
  { name:'Google Ads', status:'live', color:'#EA4335', spend:'₹9.8L', leads:1163 },
  { name:'YouTube', status:'paused', color:'#FF0000', spend:'₹4.1L', leads:446 },
  { name:'Housing.com', status:'live', color:'#7C3AED', spend:'₹2.4L', leads:375 },
  { name:'99acres', status:'live', color:'#E06B00', spend:'₹3.2L', leads:552 },
  { name:'MagicBricks', status:'review', color:'#0F766E', spend:'₹1.8L', leads:250 },
]

const STATUS_MAP = { live:['var(--pg-green)','var(--pg-tint-green)','🟢 Live'], paused:['var(--pg-gold)','var(--pg-tint-amber)','🟡 Paused'], review:['var(--pg-red)','var(--pg-tint-red)','🔴 Review'] }

const CAMPAIGNS = [
  { project:'Lodha Amara 3BHK', creative:'Thane Dream Home', channel:'Meta Reels', budget:'₹4.2L', impressions:'1.24M', leads:1321, status:'live' },
  { project:'Godrej Hillside 2BHK', creative:'Affordable Luxury', channel:'Google Search', budget:'₹2.1L', impressions:'342K', leads:98, status:'review' },
  { project:'Kalpataru Vista', creative:'Nature Living', channel:'Meta + Google', budget:'₹3.8L', impressions:'890K', leads:854, status:'live' },
  { project:'Prestige Lakeside', creative:'Lakeside Dream', channel:'Instagram', budget:'₹1.9L', impressions:'560K', leads:340, status:'paused' },
]

export default function CampaignDeployment() {
  return (
    <div style={{ padding:'28px 32px', maxWidth:1280 }}>
      <ModuleHeader module="MODULE 06" title="Deploy & Track Campaigns"
        rightContent={<button style={{ padding:'9px 18px', background:'var(--pg-gold)', color:'var(--pg-on-gold)', border:'none', borderRadius:'var(--pg-r-md)', fontSize:13, fontWeight:700, cursor:'pointer' }}>⚡ One-click deploy</button>}
      />
      {/* Channel cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:12, marginBottom:28 }}>
        {CHANNELS.map(ch=>{
          const [c,bg,label] = STATUS_MAP[ch.status]
          return (
            <div key={ch.name} style={{ background:'var(--pg-surface)', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-xl)', padding:'16px', textAlign:'center' }}>
              <div style={{ width:40, height:40, borderRadius:10, background:`color-mix(in srgb, ${ch.color} 12%, transparent)`, display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 10px', fontSize:18 }}>📡</div>
              <div style={{ fontWeight:700, fontSize:12, marginBottom:4 }}>{ch.name}</div>
              <div style={{ background:bg, color:c, padding:'2px 8px', borderRadius:20, fontSize:10, fontWeight:700, fontFamily:'var(--pg-font-mono)', display:'inline-block', marginBottom:8 }}>{label}</div>
              <div style={{ fontSize:11, color:'var(--pg-ink-2)' }}>{ch.spend}</div>
              <div style={{ fontSize:11, color:'var(--pg-ink)', fontWeight:600 }}>{ch.leads.toLocaleString()} leads</div>
            </div>
          )
        })}
      </div>
      {/* Table */}
      <div style={{ background:'var(--pg-surface)', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-xl)', overflow:'hidden' }}>
        <div style={{ padding:'16px 24px', borderBottom:'1px solid var(--pg-border)', fontWeight:700, fontSize:15 }}>Active Campaign Deployments</div>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ background:'var(--pg-shell)' }}>
              {['Project','Creative','Channel','Budget','Impressions','Leads','Status','Action'].map(h=>(
                <th key={h} style={{ padding:'10px 14px', textAlign:'left', fontSize:11, color:'var(--pg-ink-3)', fontWeight:600, letterSpacing:'0.05em', textTransform:'uppercase', fontFamily:'var(--pg-font-mono)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CAMPAIGNS.map((c,i)=>{
              const [col,bg,label] = STATUS_MAP[c.status]
              return (
                <tr key={i} style={{ borderTop:'1px solid var(--pg-border)' }}>
                  <td style={{ padding:'12px 14px', fontWeight:600, fontSize:13 }}>{c.project}</td>
                  <td style={{ padding:'12px 14px', fontSize:13, color:'var(--pg-ink-2)' }}>{c.creative}</td>
                  <td style={{ padding:'12px 14px', fontSize:13 }}>{c.channel}</td>
                  <td style={{ padding:'12px 14px', fontSize:13, fontFamily:'var(--pg-font-mono)' }}>{c.budget}</td>
                  <td style={{ padding:'12px 14px', fontSize:13, fontFamily:'var(--pg-font-mono)' }}>{c.impressions}</td>
                  <td style={{ padding:'12px 14px', fontSize:13, fontWeight:600 }}>{c.leads.toLocaleString()}</td>
                  <td style={{ padding:'12px 14px' }}><span style={{ background:bg, color:col, padding:'3px 9px', borderRadius:20, fontSize:11, fontWeight:700 }}>{label}</span></td>
                  <td style={{ padding:'12px 14px' }}><button style={{ padding:'5px 12px', border:'1px solid var(--pg-border)', borderRadius:6, background:'var(--pg-surface)', fontSize:12, cursor:'pointer' }}>Manage</button></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

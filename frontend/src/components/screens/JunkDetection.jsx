import React from 'react'
import ModuleHeader from '../shared/ModuleHeader.jsx'

const JUNK_LEADS = [
  { name:'Test User 001', phone:'+91 0000000000', source:'Meta Ad', project:'Lodha Amara', reason:'Test lead', tag:'TEST', color:'var(--pg-indigo-light)' },
  { name:'Duplicate - Amit', phone:'+91 9876543210', source:'99acres', project:'Lodha Amara', reason:'Duplicate phone', tag:'DUPLICATE', color:'var(--pg-gold)' },
  { name:'Bot Submit #432', phone:'+91 1234567890', source:'Google Ad', project:'Kalpataru Vista', reason:'Bot traffic', tag:'BOT', color:'var(--pg-red)' },
  { name:'Spam Form', phone:'+91 9999999999', source:'Housing.com', project:'Godrej Hillside', reason:'Spam form submission', tag:'SPAM', color:'var(--pg-red)' },
  { name:'Fake Number', phone:'+91 1111111111', source:'MagicBricks', project:'Prestige Lakeside', reason:'Invalid number', tag:'FAKE', color:'var(--pg-red)' },
  { name:'Test Lead #87', phone:'+91 8888888888', source:'WhatsApp', project:'Piramal Vaikunth', reason:'Test submission', tag:'TEST', color:'var(--pg-indigo-light)' },
]

export default function JunkDetection() {
  return (
    <div style={{ padding:'28px 32px', maxWidth:1280 }}>
      <ModuleHeader module="MODULE 09" title="Junk & Fraud Detection"
        subtitle="Rakshak filtered 1,247 junk leads this month — saving ~₹5.3L in wasted follow-up cost"
      />
      {/* Junk type chips */}
      <div style={{ display:'flex', gap:10, marginBottom:24, flexWrap:'wrap' }}>
        {[['Duplicates','512','var(--pg-gold)'],['Fake numbers','318','var(--pg-red)'],['Spam forms','196','var(--pg-red)'],['Bot traffic','142','var(--pg-indigo-light)'],['Test leads','79','var(--pg-ink-3)']].map(([label,count,color])=>(
          <div key={label} style={{ padding:'8px 16px', background:'var(--pg-surface)', border:`1px solid color-mix(in srgb, ${color} 27%, transparent)`, borderRadius:'var(--pg-r-md)', fontSize:13, fontWeight:600, color:'var(--pg-ink)', display:'flex', gap:8 }}>
            {label}: <span style={{ color, fontFamily:'var(--pg-font-mono)' }}>{count}</span>
          </div>
        ))}
      </div>
      {/* Stats row */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:14, marginBottom:24 }}>
        {[['Total Blocked','1,247','var(--pg-red)'],['Cost Saved','~₹5.3L','var(--pg-green)'],['Block Rate','9.1%','var(--pg-surface-dark)'],['Accuracy','99.2%','var(--pg-gold)']].map(([l,v,c])=>(
          <div key={l} style={{ background:'var(--pg-surface)', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-xl)', padding:'18px 20px' }}>
            <div style={{ fontSize:11, color:'var(--pg-ink-3)', fontFamily:'var(--pg-font-mono)', letterSpacing:'0.06em', marginBottom:6 }}>{l}</div>
            <div style={{ fontSize:26, fontWeight:800, color:c }}>{v}</div>
          </div>
        ))}
      </div>
      {/* Table */}
      <div style={{ background:'var(--pg-surface)', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-xl)', overflow:'hidden' }}>
        <div style={{ padding:'14px 20px', borderBottom:'1px solid var(--pg-border)', fontWeight:700, fontSize:15 }}>Recent Junk Leads</div>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ background:'var(--pg-shell)' }}>
              {['Name','Phone','Source','Project','Reason','Tag','Action'].map(h=>(
                <th key={h} style={{ padding:'10px 14px', textAlign:'left', fontSize:11.5, color:'var(--pg-ink-3)', fontWeight:600, letterSpacing:'0.05em', textTransform:'uppercase', fontFamily:'var(--pg-font)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {JUNK_LEADS.map((l,i)=>(
              <tr key={i} style={{ borderTop:'1px solid var(--pg-border)' }}>
                <td style={{ padding:'11px 14px', fontSize:13, fontWeight:500, textDecoration:'line-through', color:'var(--pg-ink-3)' }}>{l.name}</td>
                <td style={{ padding:'11px 14px', fontSize:12, fontFamily:'var(--pg-font-mono)', color:'var(--pg-ink-3)' }}>{l.phone}</td>
                <td style={{ padding:'11px 14px', fontSize:12, color:'var(--pg-ink-2)' }}>{l.source}</td>
                <td style={{ padding:'11px 14px', fontSize:12, color:'var(--pg-ink-2)' }}>{l.project}</td>
                <td style={{ padding:'11px 14px', fontSize:12 }}>{l.reason}</td>
                <td style={{ padding:'11px 14px' }}>
                  <span style={{ background:`color-mix(in srgb, ${l.color} 15%, transparent)`, color:l.color, padding:'3px 9px', borderRadius:'var(--pg-r-sm)', fontSize:10, fontWeight:700, fontFamily:'var(--pg-font-mono)' }}>{l.tag}</span>
                </td>
                <td style={{ padding:'11px 14px' }}>
                  <button style={{ padding:'4px 10px', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-sm)', background:'var(--pg-surface)', fontSize:11, cursor:'pointer', marginRight:6 }}>Restore</button>
                  <button style={{ padding:'4px 10px', border:'1px solid var(--pg-tint-red)', borderRadius:'var(--pg-r-sm)', background:'var(--pg-tint-red)', color:'var(--pg-red)', fontSize:11, cursor:'pointer' }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

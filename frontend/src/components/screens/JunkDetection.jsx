import React from 'react'
import ModuleHeader from '../shared/ModuleHeader.jsx'

const JUNK_LEADS = [
  { name:'Test User 001', phone:'+91 0000000000', source:'Meta Ad', project:'Lodha Amara', reason:'Test lead', tag:'TEST', color:'#8B8BD6' },
  { name:'Duplicate - Amit', phone:'+91 9876543210', source:'99acres', project:'Lodha Amara', reason:'Duplicate phone', tag:'DUPLICATE', color:'#F7941D' },
  { name:'Bot Submit #432', phone:'+91 1234567890', source:'Google Ad', project:'Kalpataru Vista', reason:'Bot traffic', tag:'BOT', color:'#D64545' },
  { name:'Spam Form', phone:'+91 9999999999', source:'Housing.com', project:'Godrej Hillside', reason:'Spam form submission', tag:'SPAM', color:'#D64545' },
  { name:'Fake Number', phone:'+91 1111111111', source:'MagicBricks', project:'Prestige Lakeside', reason:'Invalid number', tag:'FAKE', color:'#D64545' },
  { name:'Test Lead #87', phone:'+91 8888888888', source:'WhatsApp', project:'Piramal Vaikunth', reason:'Test submission', tag:'TEST', color:'#8B8BD6' },
]

export default function JunkDetection() {
  return (
    <div style={{ padding:'28px 32px', maxWidth:1280 }}>
      <ModuleHeader module="MODULE 09" title="Junk & Fraud Detection"
        subtitle="Rakshak filtered 1,247 junk leads this month — saving ~₹5.3L in wasted follow-up cost"
      />
      {/* Junk type chips */}
      <div style={{ display:'flex', gap:10, marginBottom:24, flexWrap:'wrap' }}>
        {[['Duplicates','512','#F7941D'],['Fake numbers','318','#D64545'],['Spam forms','196','#D64545'],['Bot traffic','142','#8B8BD6'],['Test leads','79','#8A8896']].map(([label,count,color])=>(
          <div key={label} style={{ padding:'8px 16px', background:'#fff', border:`1px solid ${color}44`, borderRadius:20, fontSize:13, fontWeight:600, color:'#1B1B3A', display:'flex', gap:8 }}>
            {label}: <span style={{ color, fontFamily:"'IBM Plex Mono',monospace" }}>{count}</span>
          </div>
        ))}
      </div>
      {/* Stats row */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:14, marginBottom:24 }}>
        {[['Total Blocked','1,247','#D64545'],['Cost Saved','~₹5.3L','#2E9E4F'],['Block Rate','9.1%','#0E0E52'],['Accuracy','99.2%','#F7941D']].map(([l,v,c])=>(
          <div key={l} style={{ background:'#fff', border:'1px solid #E9E7E0', borderRadius:12, padding:'18px 20px' }}>
            <div style={{ fontSize:11, color:'#8A8896', fontFamily:"'IBM Plex Mono',monospace", letterSpacing:'0.06em', marginBottom:6 }}>{l}</div>
            <div style={{ fontSize:26, fontWeight:800, color:c }}>{v}</div>
          </div>
        ))}
      </div>
      {/* Table */}
      <div style={{ background:'#fff', border:'1px solid #E9E7E0', borderRadius:12, overflow:'hidden' }}>
        <div style={{ padding:'14px 20px', borderBottom:'1px solid #E9E7E0', fontWeight:700, fontSize:15 }}>Recent Junk Leads</div>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ background:'#F6F5F1' }}>
              {['Name','Phone','Source','Project','Reason','Tag','Action'].map(h=>(
                <th key={h} style={{ padding:'10px 14px', textAlign:'left', fontSize:11, color:'#8A8896', fontWeight:600, letterSpacing:'0.05em', textTransform:'uppercase', fontFamily:"'IBM Plex Mono',monospace" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {JUNK_LEADS.map((l,i)=>(
              <tr key={i} style={{ borderTop:'1px solid #E9E7E0' }}>
                <td style={{ padding:'11px 14px', fontSize:13, fontWeight:500, textDecoration:'line-through', color:'#8A8896' }}>{l.name}</td>
                <td style={{ padding:'11px 14px', fontSize:12, fontFamily:"'IBM Plex Mono',monospace", color:'#8A8896' }}>{l.phone}</td>
                <td style={{ padding:'11px 14px', fontSize:12, color:'#75737F' }}>{l.source}</td>
                <td style={{ padding:'11px 14px', fontSize:12, color:'#75737F' }}>{l.project}</td>
                <td style={{ padding:'11px 14px', fontSize:12 }}>{l.reason}</td>
                <td style={{ padding:'11px 14px' }}>
                  <span style={{ background:`${l.color}18`, color:l.color, padding:'3px 9px', borderRadius:4, fontSize:10, fontWeight:700, fontFamily:"'IBM Plex Mono',monospace" }}>{l.tag}</span>
                </td>
                <td style={{ padding:'11px 14px' }}>
                  <button style={{ padding:'4px 10px', border:'1px solid #E9E7E0', borderRadius:6, background:'#fff', fontSize:11, cursor:'pointer', marginRight:6 }}>Restore</button>
                  <button style={{ padding:'4px 10px', border:'1px solid #FDEAEA', borderRadius:6, background:'#FDEAEA', color:'#D64545', fontSize:11, cursor:'pointer' }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
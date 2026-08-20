import React, { useState, useEffect } from 'react'
import ModuleHeader from '../shared/ModuleHeader.jsx'

const CALL_LOG = [
  { name:'Rahul Mehta', phone:'+91 9900112233', project:'Lodha Amara', duration:'4m 12s', result:'Qualified', score:91 },
  { name:'Amit Sharma', phone:'+91 9876543210', project:'Lodha Amara', duration:'3m 45s', result:'Visit Booked', score:82 },
  { name:'Priya Nair', phone:'+91 7788990011', project:'Godrej Hillside', duration:'2m 18s', result:'Follow-up', score:45 },
  { name:'Suresh Patel', phone:'+91 9988776655', project:'Piramal Vaikunth', duration:'5m 02s', result:'Qualified', score:67 },
  { name:'Deepa Singh', phone:'+91 7766554433', project:'Shapoorji Joyville', duration:'1m 47s', result:'Not Interested', score:54 },
  { name:'Kavita Joshi', phone:'+91 8877665544', project:'Kalpataru Vista', duration:'0m 32s', result:'No Answer', score:38 },
]

const RESULT_COLOR = { Qualified:'var(--pg-green)', 'Visit Booked':'var(--pg-surface-dark)', 'Follow-up':'var(--pg-gold)', 'Not Interested':'var(--pg-red)', 'No Answer':'var(--pg-ink-3)' }

export default function AICallingAgent() {
  const [timer, setTimer] = useState(84)
  useEffect(()=>{
    const t = setInterval(()=>setTimer(s=>s+1), 1000)
    return ()=>clearInterval(t)
  },[])
  const fmt = s => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`
  return (
    <div style={{ padding:'28px 32px', maxWidth:1280 }}>
      <ModuleHeader module="MODULE 10" title="Aria · Voice Qualification"
        subtitle="Calls every new lead within 30 seconds · Hindi, English & Marathi · Retell + Sarvam voice"
        rightContent={<div style={{ display:'flex', gap:8, alignItems:'center' }}><span style={{ width:8, height:8, borderRadius:'50%', background:'var(--pg-green)', display:'inline-block' }} /><span style={{ fontWeight:700, color:'var(--pg-green)', fontSize:13 }}>92% connect rate today</span></div>}
      />
      <div style={{ display:'grid', gridTemplateColumns:'400px 1fr', gap:24, marginBottom:24 }}>
        {/* Live call panel */}
        <div style={{ background:'var(--pg-surface-dark)', borderRadius:'var(--pg-r-3xl)', padding:'24px', color:'#fff' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              <span style={{ width:8, height:8, borderRadius:'50%', background:'var(--pg-green)', display:'inline-block', animation:'pulse 1s infinite' }} />
              <span style={{ fontSize:12, fontFamily:'var(--pg-font-mono)', color:'var(--pg-green)', fontWeight:700 }}>LIVE CALL</span>
            </div>
            <span style={{ fontSize:20, fontWeight:800, fontFamily:'var(--pg-font-mono)', color:'var(--pg-gold)' }}>{fmt(timer)}</span>
          </div>
          <div style={{ display:'flex', gap:14, alignItems:'center', marginBottom:20 }}>
            <div style={{ width:52, height:52, borderRadius:'50%', background:'var(--pg-gold)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:22, fontWeight:700, color:'var(--pg-on-gold)' }}>R</div>
            <div>
              <div style={{ fontWeight:700, fontSize:16 }}>Rahul Mehta</div>
              <div style={{ fontSize:12, color:'rgba(255,255,255,0.5)' }}>Lodha Amara · Score 91 🔥</div>
            </div>
          </div>
          <div style={{ background:'rgba(255,255,255,0.08)', borderRadius:10, padding:'14px', marginBottom:20, fontSize:13, color:'rgba(255,255,255,0.9)', lineHeight:1.7, fontStyle:'italic' }}>
            "नमस्ते Rahul ji, main propOG se Aria bol rahi hoon. Aapne Lodha Amara 3BHK ke baare mein enquiry ki thi — kya aap abhi baat kar sakte hain?"
          </div>
          <div style={{ display:'flex', gap:10, justifyContent:'center' }}>
            {['🔇','⏸','📝','📞'].map((icon,i)=>(
              <button key={i} style={{ width:42, height:42, borderRadius:'50%', background:'rgba(255,255,255,0.12)', border:'none', fontSize:18, cursor:'pointer' }}>{icon}</button>
            ))}
            <button style={{ width:42, height:42, borderRadius:'50%', background:'var(--pg-red)', border:'none', fontSize:16, cursor:'pointer', color:'#fff' }}>✕</button>
          </div>
        </div>
        {/* Stats */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:14, alignContent:'start' }}>
          {[['Total Calls Today','728','▲ 12% vs yesterday','var(--pg-surface-dark)'],['Connect Rate','92%','670 connected','var(--pg-green)'],['Qualified','340','46.6% of connects','var(--pg-gold)'],['Visits Scheduled','67','19.7% of qualified','var(--pg-indigo-light)']].map(([l,v,s,c])=>(
            <div key={l} style={{ background:'var(--pg-surface)', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-xl)', padding:'18px 20px', borderTop:`3px solid ${c}` }}>
              <div style={{ fontSize:11, color:'var(--pg-ink-3)', fontFamily:'var(--pg-font-mono)', marginBottom:6 }}>{l}</div>
              <div style={{ fontSize:22, fontWeight:800, color:'var(--pg-ink)' }}>{v}</div>
              <div style={{ fontSize:12, color:'var(--pg-ink-2)', marginTop:4 }}>{s}</div>
            </div>
          ))}
        </div>
      </div>
      {/* Call log */}
      <div style={{ background:'var(--pg-surface)', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-xl)', overflow:'hidden' }}>
        <div style={{ padding:'14px 20px', borderBottom:'1px solid var(--pg-border)', fontWeight:700, fontSize:15 }}>{"Today's Call Log"}</div>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ background:'var(--pg-shell)' }}>
              {['Lead','Phone','Project','Duration','Result','Score'].map(h=>(
                <th key={h} style={{ padding:'10px 14px', textAlign:'left', fontSize:11.5, color:'var(--pg-ink-3)', fontWeight:600, letterSpacing:'0.05em', textTransform:'uppercase', fontFamily:'var(--pg-font)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CALL_LOG.map((c,i)=>(
              <tr key={i} style={{ borderTop:'1px solid var(--pg-border)' }}>
                <td style={{ padding:'11px 14px', fontWeight:600, fontSize:13 }}>{c.name}</td>
                <td style={{ padding:'11px 14px', fontSize:12, fontFamily:'var(--pg-font-mono)', color:'var(--pg-ink-2)' }}>{c.phone}</td>
                <td style={{ padding:'11px 14px', fontSize:12 }}>{c.project}</td>
                <td style={{ padding:'11px 14px', fontSize:12, fontFamily:'var(--pg-font-mono)' }}>{c.duration}</td>
                <td style={{ padding:'11px 14px' }}>
                  <span style={{ background:`color-mix(in srgb, ${RESULT_COLOR[c.result]} 15%, transparent)`, color:RESULT_COLOR[c.result], padding:'3px 9px', borderRadius:'var(--pg-r-md)', fontSize:11, fontWeight:600 }}>{c.result}</span>
                </td>
                <td style={{ padding:'11px 14px', fontWeight:700, color:c.score>=75?'var(--pg-green)':c.score>=45?'var(--pg-gold)':'var(--pg-indigo-light)' }}>{c.score}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

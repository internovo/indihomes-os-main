import React, { useState } from 'react'
import ModuleHeader from '../shared/ModuleHeader.jsx'

const GROUPS = [
  { name:'Lodha Group', projects:3, color:'var(--pg-surface-dark)', last:'Just now', count:3 },
  { name:'Godrej Properties', projects:2, color:'var(--pg-green)', last:'5m ago', count:1 },
  { name:'Kalpataru Ltd', projects:1, color:'var(--pg-gold)', last:'1h ago', count:0 },
  { name:'Piramal Realty', projects:1, color:'var(--pg-indigo-light)', last:'2h ago', count:2 },
  { name:'Prestige Group', projects:1, color:'var(--pg-red)', last:'Yesterday', count:0 },
]

const MESSAGES = [
  { sender:'Lodha Team', avatar:'L', text:'Campaign for Amara 3BHK is performing exceptionally — 1,321 leads with ₹318 CPL. Can we increase the budget by 20% this week?', time:'10:32 AM', isMe:false },
  { sender:'Aarti Rawat', avatar:'A', text:"Absolutely! I'll approve ₹84K additional budget. Rachna will update the creative set too for the extended run.", time:'10:45 AM', isMe:true },
  { sender:'Lodha Team', avatar:'L', text:'Perfect. Also, 14 visit bookings confirmed for Saturday — please ensure the sales team at Thane gallery is briefed.', time:'11:02 AM', isMe:false },
  { sender:'Aarti Rawat', avatar:'A', text:'Done — Aria has already sent confirmation messages. The sales team has been notified via the CRM.', time:'11:15 AM', isMe:true },
]

export default function BuilderCollaboration() {
  const [activeGroup, setActiveGroup] = useState(0)
  const [msg, setMsg] = useState('')
  return (
    <div style={{ padding:'28px 32px', maxWidth:1280 }}>
      <ModuleHeader module="MODULE 15" title="Builder Collaboration" subtitle="Real-time builder groups · automatic performance updates · 5 active groups" />
      <div style={{ display:'grid', gridTemplateColumns:'280px 1fr', gap:20, height:560 }}>
        {/* Groups list */}
        <div style={{ background:'var(--pg-surface)', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-2xl)', overflow:'hidden' }}>
          <div style={{ padding:'14px 16px', borderBottom:'1px solid var(--pg-border)', fontSize:13, fontWeight:700 }}>Builder Groups</div>
          {GROUPS.map((g,i)=>(
            <div key={g.name} onClick={()=>setActiveGroup(i)} style={{ display:'flex', gap:12, padding:'12px 16px', borderBottom:'1px solid var(--pg-border)', cursor:'pointer', background:activeGroup===i?'var(--pg-shell)':'var(--pg-surface)' }}>
              <div style={{ width:40, height:40, borderRadius:10, background:g.color, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--pg-on-dark)', fontWeight:700, fontSize:16, flexShrink:0 }}>{g.name[0]}</div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontWeight:600, fontSize:13 }}>{g.name}</div>
                <div style={{ fontSize:11, color:'var(--pg-ink-2)' }}>{g.projects} project{g.projects>1?'s':''} · {g.last}</div>
              </div>
              {g.count>0 && <span style={{ width:18, height:18, background:'var(--pg-red)', borderRadius:'50%', color:'var(--pg-on-dark)', fontSize:10, fontWeight:700, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>{g.count}</span>}
            </div>
          ))}
        </div>
        {/* Chat */}
        <div style={{ background:'var(--pg-surface)', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-2xl)', overflow:'hidden', display:'flex', flexDirection:'column' }}>
          <div style={{ background:'var(--pg-surface-dark)', padding:'14px 18px', display:'flex', alignItems:'center', gap:12 }}>
            <div style={{ width:36, height:36, borderRadius:8, background:'rgba(255,255,255,0.15)', display:'flex', alignItems:'center', justifyContent:'center', color:'var(--pg-on-dark)', fontWeight:700, fontSize:16 }}>L</div>
            <div>
              <div style={{ color:'var(--pg-on-dark)', fontWeight:700, fontSize:14 }}>{GROUPS[activeGroup].name}</div>
              <div style={{ color:'rgba(255,255,255,0.5)', fontSize:11 }}>{GROUPS[activeGroup].projects} projects · Active</div>
            </div>
            <div style={{ marginLeft:'auto', display:'flex', gap:8 }}>
              {['📎','📊','⋯'].map((ic,i)=><button key={i} style={{ background:'rgba(255,255,255,0.1)', border:'none', borderRadius:6, padding:'6px 10px', color:'var(--pg-on-dark)', cursor:'pointer', fontSize:14 }}>{ic}</button>)}
            </div>
          </div>
          <div style={{ flex:1, overflowY:'auto', padding:'16px', display:'flex', flexDirection:'column', gap:12 }}>
            {MESSAGES.map((m,i)=>(
              <div key={i} style={{ display:'flex', gap:10, flexDirection:m.isMe?'row-reverse':'row' }}>
                <div style={{ width:32, height:32, borderRadius:'50%', background:m.isMe?'var(--pg-gold)':'var(--pg-surface-dark)', display:'flex', alignItems:'center', justifyContent:'center', color:m.isMe?'var(--pg-on-gold)':'var(--pg-on-dark)', fontWeight:700, fontSize:13, flexShrink:0 }}>{m.avatar}</div>
                <div style={{ maxWidth:'70%' }}>
                  <div style={{ fontSize:10, color:'var(--pg-ink-3)', marginBottom:3, textAlign:m.isMe?'right':'left' }}>{m.sender} · {m.time}</div>
                  <div style={{ background:m.isMe?'var(--pg-surface-dark)':'var(--pg-shell)', color:m.isMe?'var(--pg-on-dark)':'var(--pg-ink)', padding:'10px 14px', borderRadius:m.isMe?'12px 2px 12px 12px':'2px 12px 12px 12px', fontSize:13, lineHeight:1.5 }}>{m.text}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ padding:'12px 14px', borderTop:'1px solid var(--pg-border)', display:'flex', gap:10 }}>
            <input value={msg} onChange={e=>setMsg(e.target.value)} placeholder="Type a message..." style={{ flex:1, padding:'9px 14px', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-md)', fontSize:13, outline:'none', fontFamily:'var(--pg-font)' }} />
            <button onClick={()=>setMsg('')} style={{ padding:'9px 18px', background:'var(--pg-surface-dark)', color:'var(--pg-on-dark)', border:'none', borderRadius:'var(--pg-r-md)', fontSize:13, fontWeight:600, cursor:'pointer' }}>Send</button>
          </div>
        </div>
      </div>
    </div>
  )
}

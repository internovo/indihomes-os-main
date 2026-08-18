import React from 'react'
import ModuleHeader from '../shared/ModuleHeader.jsx'

const CONVOS = [
  { name:'Amit Sharma', project:'Lodha Amara', last:'Book Sat 11 AM', time:'2m ago', status:'Visit booked', score:82 },
  { name:'Priya Nair', project:'Godrej Hillside', last:'What is the price range?', time:'8m ago', status:'Enquiry', score:45 },
  { name:'Suresh Patel', project:'Piramal Vaikunth', last:'Send me the floor plan', time:'15m ago', status:'Engaged', score:67 },
  { name:'Rahul Mehta', project:'Lodha Amara', last:'Thank you for the info', time:'32m ago', status:'Qualified', score:91 },
  { name:'Deepa Singh', project:'Shapoorji Joyville', last:'OK I will think about it', time:'1h ago', status:'Warm', score:54 },
]

export default function WhatsAppAgent() {
  return (
    <div style={{ padding:'28px 32px', maxWidth:1280 }}>
      <ModuleHeader module="MODULE 11" title="Vaani · WhatsApp Concierge"
        subtitle="2,140 messages sent today · 78% response rate · Auto-books site visits"
      />
      <div style={{ display:'grid', gridTemplateColumns:'330px 1fr', gap:20 }}>
        {/* Chat preview */}
        <div style={{ borderRadius:16, overflow:'hidden', border:'1px solid #E9E7E0', boxShadow:'0 4px 20px rgba(0,0,0,0.08)' }}>
          {/* WA header */}
          <div style={{ background:'#075E54', padding:'14px 16px', display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ width:36, height:36, borderRadius:'50%', background:'#25D366', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, color:'#fff' }}>A</div>
            <div>
              <div style={{ color:'#fff', fontWeight:600, fontSize:13 }}>Amit Sharma</div>
              <div style={{ color:'rgba(255,255,255,0.6)', fontSize:11 }}>online · Lodha Amara enquiry</div>
            </div>
          </div>
          {/* Messages */}
          <div style={{ background:'#ECE5DD', padding:'12px', display:'flex', flexDirection:'column', gap:8, minHeight:380 }}>
            <div style={{ alignSelf:'flex-start', background:'#fff', borderRadius:'0 8px 8px 8px', padding:'10px 12px', maxWidth:'85%', fontSize:12, lineHeight:1.5, boxShadow:'0 1px 2px rgba(0,0,0,0.1)' }}>
              {"नमस्ते Amit 🙏 Welcome to Lodha Amara! I'm Vaani, your personal property assistant. How can I help you today?"}
            </div>
            <div style={{ alignSelf:'flex-start', background:'#fff', borderRadius:'8px', padding:'10px 12px', maxWidth:'85%', fontSize:12, lineHeight:1.5, boxShadow:'0 1px 2px rgba(0,0,0,0.1)' }}>
              <div style={{ marginBottom:6 }}>Here are your resources for Lodha Amara 3 BHK:</div>
              {['📄 Brochure.pdf','📐 Floor plan · 2BHK & 3BHK','💰 Price sheet · June 2026','📍 Location map · Thane West'].map(r=>(
                <div key={r} style={{ color:'#0E0E52', fontWeight:600, marginBottom:3 }}>{r}</div>
              ))}
            </div>
            <div style={{ alignSelf:'flex-end', background:'#DCF8C6', borderRadius:'8px 0 8px 8px', padding:'10px 12px', maxWidth:'85%', fontSize:12, lineHeight:1.5, boxShadow:'0 1px 2px rgba(0,0,0,0.1)' }}>
              Can I visit this weekend?
            </div>
            <div style={{ alignSelf:'flex-start', background:'#fff', borderRadius:'8px', padding:'10px 12px', maxWidth:'90%', fontSize:12, lineHeight:1.6, boxShadow:'0 1px 2px rgba(0,0,0,0.1)' }}>
              Of course! 🗓️ Available slots at Thane sales gallery:<br/>
              <strong>Sat 28 Jun · 11:00 AM</strong><br/>
              <strong>Sun 29 Jun · 04:00 PM</strong><br/>
              Which works for you?
            </div>
            <div style={{ alignSelf:'flex-end', background:'#DCF8C6', borderRadius:'8px 0 8px 8px', padding:'10px 12px', fontSize:12, boxShadow:'0 1px 2px rgba(0,0,0,0.1)' }}>
              Book Sat 11 AM
            </div>
            <div style={{ alignSelf:'flex-start', background:'#fff', borderRadius:'8px', padding:'10px 12px', maxWidth:'90%', fontSize:12, lineHeight:1.6, boxShadow:'0 1px 2px rgba(0,0,0,0.1)' }}>
              {"Confirmed! ✅ You're booked for "}<strong>Saturday 28 June at 11:00 AM</strong>{" at the Lodha Amara Sales Gallery, Thane West. See you there! 🏢"}
            </div>
          </div>
        </div>
        {/* Stats + convo list */}
        <div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12, marginBottom:20 }}>
            {[['Messages Today','2,140','#0E0E52'],['Response Rate','78%','#2E9E4F'],['Visits Booked','43','#F7941D']].map(([l,v,c])=>(
              <div key={l} style={{ background:'#fff', border:'1px solid #E9E7E0', borderRadius:12, padding:'16px 18px', borderTop:`3px solid ${c}` }}>
                <div style={{ fontSize:11, color:'#8A8896', fontFamily:"'IBM Plex Mono',monospace", marginBottom:4 }}>{l}</div>
                <div style={{ fontSize:26, fontWeight:800, color:'#1B1B3A' }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ background:'#fff', border:'1px solid #E9E7E0', borderRadius:12, overflow:'hidden' }}>
            <div style={{ padding:'14px 18px', borderBottom:'1px solid #E9E7E0', fontWeight:700, fontSize:14 }}>Recent Conversations</div>
            {CONVOS.map((c,i)=>(
              <div key={i} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 18px', borderBottom:'1px solid #E9E7E0', cursor:'pointer' }}
                onMouseEnter={e=>e.currentTarget.style.background='#F6F5F1'}
                onMouseLeave={e=>e.currentTarget.style.background='#fff'}
              >
                <div style={{ width:40, height:40, borderRadius:'50%', background:'#25D36622', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, color:'#075E54', flexShrink:0 }}>{c.name[0]}</div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:'flex', justifyContent:'space-between' }}>
                    <span style={{ fontWeight:600, fontSize:13 }}>{c.name}</span>
                    <span style={{ fontSize:11, color:'#8A8896' }}>{c.time}</span>
                  </div>
                  <div style={{ fontSize:11, color:'#75737F', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{c.last}</div>
                  <div style={{ fontSize:10, color:'#2E9E4F', fontWeight:600, marginTop:2 }}>{c.project} · {c.status}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
import React from 'react'
import ModuleHeader from '../shared/ModuleHeader.jsx'
import StatCard from '../shared/StatCard.jsx'

const CALLERS = [
  { name:'Rohan Desai', calls:142, connected:131, qualified:68, visits:14, score:76, status:'active' },
  { name:'Sneha Kulkarni', calls:138, connected:127, qualified:61, visits:12, score:72, status:'active' },
  { name:'Arjun Verma', calls:124, connected:112, qualified:54, visits:11, score:69, status:'active' },
  { name:'Pooja Sharma', calls:118, connected:108, qualified:49, visits:9, score:66, status:'break' },
  { name:'Kiran Patel', calls:112, connected:101, qualified:42, visits:8, score:64, status:'active' },
  { name:'Meera Nair', calls:94, connected:81, qualified:66, visits:13, score:82, status:'active' },
]

export default function CallerDashboard() {
  return (
    <div style={{ padding:'28px 32px', maxWidth:1280 }}>
      <ModuleHeader title="Caller Dashboard" subtitle="6 executive callers · live productivity tracking"
        rightContent={<>
          <button style={{ padding:'8px 16px', border:'1px solid #E9E7E0', borderRadius:8, background:'#fff', fontSize:13, cursor:'pointer' }}>Today ⌄</button>
          <button style={{ padding:'8px 16px', background:'#FECF55', color:'#0E0E52', border:'none', borderRadius:8, fontSize:13, fontWeight:700, cursor:'pointer' }}>⬇ Generate report</button>
        </>}
      />
      <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:12, marginBottom:28 }}>
        <StatCard label="Total Calls" value="728" trend="▲ 12% vs yesterday" trendDir="up" accent="#0E0E52" />
        <StatCard label="Connects" value="670" trend="▲ 8%" trendDir="up" accent="#2E9E4F" />
        <StatCard label="Qualified" value="340" trend="▲ 15%" trendDir="up" accent="#F7941D" />
        <StatCard label="Visits Booked" value="67" trend="▲ 22%" trendDir="up" accent="#8B8BD6" />
        <StatCard label="Avg Call Time" value="4m 12s" trend="vs 3m 58s avg" trendDir="up" accent="#185FA5" />
        <StatCard label="Connect Rate" value="92%" trend="▲ Portfolio best" trendDir="up" accent="#2E9E4F" />
      </div>
      <div style={{ background:'#fff', border:'1px solid #E9E7E0', borderRadius:12, overflow:'hidden' }}>
        <div style={{ padding:'14px 20px', borderBottom:'1px solid #E9E7E0', fontWeight:700, fontSize:15 }}>Caller Performance — Today</div>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ background:'#F6F5F1' }}>
              {['Caller','Calls Today','Connected','Qualified','Visits','Avg Score','Status'].map(h=>(
                <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontSize:11, color:'#8A8896', fontWeight:600, letterSpacing:'0.05em', textTransform:'uppercase', fontFamily:"'IBM Plex Mono',monospace" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CALLERS.map((c,i)=>(
              <tr key={c.name} style={{ borderTop:'1px solid #E9E7E0', background:i%2===0?'#fff':'#fafaf8' }}>
                <td style={{ padding:'12px 16px' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <div style={{ width:32, height:32, borderRadius:'50%', background:'#0E0E5218', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, fontSize:13, color:'#0E0E52' }}>{c.name[0]}</div>
                    <span style={{ fontWeight:600, fontSize:13 }}>{c.name}</span>
                  </div>
                </td>
                <td style={{ padding:'12px 16px', fontSize:13, fontWeight:600 }}>{c.calls}</td>
                <td style={{ padding:'12px 16px', fontSize:13 }}>{c.connected}</td>
                <td style={{ padding:'12px 16px', fontSize:13, fontWeight:600, color:'#F7941D' }}>{c.qualified}</td>
                <td style={{ padding:'12px 16px', fontSize:13, fontWeight:700, color:'#2E9E4F' }}>{c.visits}</td>
                <td style={{ padding:'12px 16px' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <div style={{ flex:1, height:6, background:'#F0EEEB', borderRadius:3, overflow:'hidden' }}>
                      <div style={{ width:`${c.score}%`, height:'100%', background:c.score>=75?'#2E9E4F':c.score>=60?'#F7941D':'#8B8BD6', borderRadius:3 }} />
                    </div>
                    <span style={{ fontSize:12, fontWeight:700, minWidth:24, color:c.score>=75?'#2E9E4F':c.score>=60?'#F7941D':'#8B8BD6' }}>{c.score}</span>
                  </div>
                </td>
                <td style={{ padding:'12px 16px' }}>
                  <span style={{ display:'flex', alignItems:'center', gap:5 }}>
                    <span style={{ width:8, height:8, borderRadius:'50%', background:c.status==='active'?'#2E9E4F':'#F7941D', display:'inline-block' }} />
                    <span style={{ fontSize:12, fontWeight:600, color:c.status==='active'?'#2E9E4F':'#F7941D', textTransform:'capitalize' }}>{c.status}</span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
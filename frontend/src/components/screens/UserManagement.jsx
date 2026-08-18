import React, { useState } from 'react'
import ModuleHeader from '../shared/ModuleHeader.jsx'

const ROLES = [
  { id:'super', label:'Super Admin', count:1, color:'#0E0E52', desc:'Full platform access · All modules' },
  { id:'tech', label:'Tech Admin', count:2, color:'#185FA5', desc:'Config, integrations, API' },
  { id:'campaign', label:'Campaign Manager', count:3, color:'#F7941D', desc:'M1-M4, M12-M13' },
  { id:'lead', label:'Lead Manager', count:4, color:'#2E9E4F', desc:'M5, M8, M9, M10' },
  { id:'analyst', label:'Analyst', count:2, color:'#8B8BD6', desc:'M12, M13 read-only' },
  { id:'caller', label:'Caller', count:6, color:'#75737F', desc:'Caller dashboard only' },
]

const USERS = [
  { name:'Aarti Rawat', role:'Super Admin', email:'aarti.rawat@indihomes.in', last:'Just now', status:'active' },
  { name:'Rohan Desai', role:'Caller', email:'rohan@indihomes.in', last:'2m ago', status:'active' },
  { name:'Priya Sharma', role:'Campaign Manager', email:'priya@indihomes.in', last:'1h ago', status:'active' },
  { name:'Akash Nair', role:'Tech Admin', email:'akash@indihomes.in', last:'3h ago', status:'active' },
  { name:'Sneha Kulkarni', role:'Caller', email:'sneha@indihomes.in', last:'4m ago', status:'active' },
  { name:'Vijay Patel', role:'Analyst', email:'vijay@indihomes.in', last:'Yesterday', status:'inactive' },
]

const ROLE_COLOR = { 'Super Admin':'#0E0E52', 'Tech Admin':'#185FA5', 'Campaign Manager':'#F7941D', 'Lead Manager':'#2E9E4F', 'Analyst':'#8B8BD6', 'Caller':'#75737F' }

export default function UserManagement() {
  const [showInvite, setShowInvite] = useState(false)
  return (
    <div style={{ padding:'28px 32px', maxWidth:1280 }}>
      <ModuleHeader title="User Management"
        rightContent={<button onClick={()=>setShowInvite(!showInvite)} style={{ padding:'9px 18px', background:'#FECF55', color:'#0E0E52', border:'none', borderRadius:8, fontSize:13, fontWeight:700, cursor:'pointer' }}>＋ Invite user</button>}
      />
      {showInvite && (
        <div style={{ background:'#fff', border:'1px solid #E9E7E0', borderRadius:12, padding:'20px', marginBottom:20, display:'flex', gap:12, alignItems:'flex-end', flexWrap:'wrap' }}>
          <div>
            <label style={{ fontSize:11, color:'#8A8896', fontFamily:"'IBM Plex Mono',monospace", display:'block', marginBottom:4 }}>EMAIL</label>
            <input placeholder="user@indihomes.in" style={{ padding:'8px 12px', border:'1px solid #E9E7E0', borderRadius:8, fontSize:13, outline:'none', width:240 }} />
          </div>
          <div>
            <label style={{ fontSize:11, color:'#8A8896', fontFamily:"'IBM Plex Mono',monospace", display:'block', marginBottom:4 }}>ROLE</label>
            <select style={{ padding:'8px 12px', border:'1px solid #E9E7E0', borderRadius:8, fontSize:13, background:'#fff' }}>
              {ROLES.map(r=><option key={r.id}>{r.label}</option>)}
            </select>
          </div>
          <button onClick={()=>setShowInvite(false)} style={{ padding:'9px 18px', background:'#0E0E52', color:'#fff', border:'none', borderRadius:8, fontSize:13, fontWeight:600, cursor:'pointer' }}>Send invite</button>
          <button onClick={()=>setShowInvite(false)} style={{ padding:'9px 18px', background:'#fff', color:'#75737F', border:'1px solid #E9E7E0', borderRadius:8, fontSize:13, cursor:'pointer' }}>Cancel</button>
        </div>
      )}
      {/* Role cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:14, marginBottom:28 }}>
        {ROLES.map(r=>(
          <div key={r.id} style={{ background:'#fff', border:'1px solid #E9E7E0', borderRadius:12, padding:'16px 18px', display:'flex', alignItems:'center', gap:14 }}>
            <div style={{ width:42, height:42, borderRadius:10, background:`${r.color}18`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, flexShrink:0 }}>👤</div>
            <div style={{ flex:1 }}>
              <div style={{ fontWeight:700, fontSize:14, color:'#1B1B3A' }}>{r.label}</div>
              <div style={{ fontSize:11, color:'#75737F' }}>{r.desc}</div>
            </div>
            <div style={{ textAlign:'right', flexShrink:0 }}>
              <div style={{ fontSize:22, fontWeight:800, color:r.color }}>{r.count}</div>
              <div style={{ fontSize:10, color:'#8A8896' }}>users</div>
            </div>
          </div>
        ))}
      </div>
      {/* Users table */}
      <div style={{ background:'#fff', border:'1px solid #E9E7E0', borderRadius:12, overflow:'hidden' }}>
        <div style={{ padding:'14px 20px', borderBottom:'1px solid #E9E7E0', fontWeight:700, fontSize:15 }}>All Users (18)</div>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ background:'#F6F5F1' }}>
              {['Name','Role','Email','Last Active','Status','Actions'].map(h=>(
                <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontSize:11, color:'#8A8896', fontWeight:600, letterSpacing:'0.05em', textTransform:'uppercase', fontFamily:"'IBM Plex Mono',monospace" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {USERS.map((u,i)=>(
              <tr key={u.email} style={{ borderTop:'1px solid #E9E7E0', background:i%2===0?'#fff':'#fafaf8' }}>
                <td style={{ padding:'12px 16px' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <div style={{ width:32, height:32, borderRadius:'50%', background:`${ROLE_COLOR[u.role]}22`, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, fontSize:13, color:ROLE_COLOR[u.role] }}>{u.name[0]}</div>
                    <span style={{ fontWeight:600, fontSize:13 }}>{u.name}</span>
                  </div>
                </td>
                <td style={{ padding:'12px 16px' }}>
                  <span style={{ background:`${ROLE_COLOR[u.role]}18`, color:ROLE_COLOR[u.role], padding:'3px 9px', borderRadius:4, fontSize:11, fontWeight:600 }}>{u.role}</span>
                </td>
                <td style={{ padding:'12px 16px', fontSize:13, color:'#75737F', fontFamily:"'IBM Plex Mono',monospace" }}>{u.email}</td>
                <td style={{ padding:'12px 16px', fontSize:12, color:'#8A8896' }}>{u.last}</td>
                <td style={{ padding:'12px 16px' }}>
                  <span style={{ display:'flex', alignItems:'center', gap:5 }}>
                    <span style={{ width:7, height:7, borderRadius:'50%', background:u.status==='active'?'#2E9E4F':'#D0CEC7', display:'inline-block' }} />
                    <span style={{ fontSize:12, color:u.status==='active'?'#2E9E4F':'#8A8896', textTransform:'capitalize', fontWeight:500 }}>{u.status}</span>
                  </span>
                </td>
                <td style={{ padding:'12px 16px' }}>
                  <div style={{ display:'flex', gap:6 }}>
                    <button style={{ padding:'4px 10px', border:'1px solid #E9E7E0', borderRadius:6, background:'#fff', fontSize:11, cursor:'pointer' }}>Edit</button>
                    <button style={{ padding:'4px 10px', border:'1px solid #FDEAEA', borderRadius:6, background:'#FDEAEA', color:'#D64545', fontSize:11, cursor:'pointer' }}>Remove</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
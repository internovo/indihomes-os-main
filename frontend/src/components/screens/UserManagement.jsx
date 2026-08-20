import React, { useState } from 'react'
import ModuleHeader from '../shared/ModuleHeader.jsx'

const ROLES = [
  { id:'super', label:'Super Admin', count:1, color:'var(--pg-surface-dark)', desc:'Full platform access · All modules' },
  { id:'tech', label:'Tech Admin', count:2, color:'var(--pg-indigo)', desc:'Config, integrations, API' },
  { id:'campaign', label:'Campaign Manager', count:3, color:'var(--pg-gold)', desc:'M1-M4, M12-M13' },
  { id:'lead', label:'Lead Manager', count:4, color:'var(--pg-green)', desc:'M5, M8, M9, M10' },
  { id:'analyst', label:'Analyst', count:2, color:'var(--pg-indigo-light)', desc:'M12, M13 read-only' },
  { id:'caller', label:'Caller', count:6, color:'var(--pg-ink-2)', desc:'Caller dashboard only' },
]

const USERS = [
  { name:'Aarti Rawat', role:'Super Admin', email:'aarti.rawat@propog.in', last:'Just now', status:'active' },
  { name:'Rohan Desai', role:'Caller', email:'rohan@propog.in', last:'2m ago', status:'active' },
  { name:'Priya Sharma', role:'Campaign Manager', email:'priya@propog.in', last:'1h ago', status:'active' },
  { name:'Akash Nair', role:'Tech Admin', email:'akash@propog.in', last:'3h ago', status:'active' },
  { name:'Sneha Kulkarni', role:'Caller', email:'sneha@propog.in', last:'4m ago', status:'active' },
  { name:'Vijay Patel', role:'Analyst', email:'vijay@propog.in', last:'Yesterday', status:'inactive' },
]

const ROLE_COLOR = { 'Super Admin':'var(--pg-surface-dark)', 'Tech Admin':'var(--pg-indigo)', 'Campaign Manager':'var(--pg-gold)', 'Lead Manager':'var(--pg-green)', 'Analyst':'var(--pg-indigo-light)', 'Caller':'var(--pg-ink-2)' }

export default function UserManagement() {
  const [showInvite, setShowInvite] = useState(false)
  return (
    <div style={{ padding:'28px 32px', maxWidth:1280 }}>
      <ModuleHeader title="User Management"
        rightContent={<button onClick={()=>setShowInvite(!showInvite)} style={{ padding:'9px 18px', background:'var(--pg-gold)', color:'var(--pg-on-gold)', border:'none', borderRadius:'var(--pg-r-md)', fontSize:13, fontWeight:700, cursor:'pointer' }}>＋ Invite user</button>}
      />
      {showInvite && (
        <div style={{ background:'var(--pg-surface)', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-xl)', padding:'20px', marginBottom:20, display:'flex', gap:12, alignItems:'flex-end', flexWrap:'wrap' }}>
          <div>
            <label style={{ fontSize:11, color:'var(--pg-ink-3)', fontFamily:'var(--pg-font-mono)', display:'block', marginBottom:4 }}>EMAIL</label>
            <input placeholder="user@propog.in" style={{ padding:'8px 12px', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-md)', fontSize:13, outline:'none', width:240 }} />
          </div>
          <div>
            <label style={{ fontSize:11, color:'var(--pg-ink-3)', fontFamily:'var(--pg-font-mono)', display:'block', marginBottom:4 }}>ROLE</label>
            <select style={{ padding:'8px 12px', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-md)', fontSize:13, background:'var(--pg-surface)' }}>
              {ROLES.map(r=><option key={r.id}>{r.label}</option>)}
            </select>
          </div>
          <button onClick={()=>setShowInvite(false)} style={{ padding:'9px 18px', background:'var(--pg-surface-dark)', color:'var(--pg-on-dark)', border:'none', borderRadius:'var(--pg-r-md)', fontSize:13, fontWeight:600, cursor:'pointer' }}>Send invite</button>
          <button onClick={()=>setShowInvite(false)} style={{ padding:'9px 18px', background:'var(--pg-surface)', color:'var(--pg-ink-2)', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-md)', fontSize:13, cursor:'pointer' }}>Cancel</button>
        </div>
      )}
      {/* Role cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:14, marginBottom:28 }}>
        {ROLES.map(r=>(
          <div key={r.id} style={{ background:'var(--pg-surface)', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-xl)', padding:'16px 18px', display:'flex', alignItems:'center', gap:14 }}>
            <div style={{ width:42, height:42, borderRadius:10, background:`color-mix(in srgb, ${r.color} 15%, transparent)`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, flexShrink:0 }}>👤</div>
            <div style={{ flex:1 }}>
              <div style={{ fontWeight:700, fontSize:14, color:'var(--pg-ink)' }}>{r.label}</div>
              <div style={{ fontSize:11, color:'var(--pg-ink-2)' }}>{r.desc}</div>
            </div>
            <div style={{ textAlign:'right', flexShrink:0 }}>
              <div style={{ fontSize:22, fontWeight:800, color:r.color }}>{r.count}</div>
              <div style={{ fontSize:10, color:'var(--pg-ink-3)' }}>users</div>
            </div>
          </div>
        ))}
      </div>
      {/* Users table */}
      <div style={{ background:'var(--pg-surface)', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-xl)', overflow:'hidden' }}>
        <div style={{ padding:'14px 20px', borderBottom:'1px solid var(--pg-border)', fontWeight:700, fontSize:15 }}>All Users (18)</div>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ background:'var(--pg-shell)' }}>
              {['Name','Role','Email','Last Active','Status','Actions'].map(h=>(
                <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontSize:11.5, color:'var(--pg-ink-3)', fontWeight:600, letterSpacing:'0.05em', textTransform:'uppercase', fontFamily:'var(--pg-font)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {USERS.map((u,i)=>(
              <tr key={u.email} style={{ borderTop:'1px solid var(--pg-border)', background:i%2===0?'var(--pg-surface)':'var(--pg-shell)' }}>
                <td style={{ padding:'12px 16px' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <div style={{ width:32, height:32, borderRadius:'50%', background:`color-mix(in srgb, ${ROLE_COLOR[u.role]} 20%, transparent)`, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, fontSize:13, color:ROLE_COLOR[u.role] }}>{u.name[0]}</div>
                    <span style={{ fontWeight:600, fontSize:13 }}>{u.name}</span>
                  </div>
                </td>
                <td style={{ padding:'12px 16px' }}>
                  <span style={{ background:`color-mix(in srgb, ${ROLE_COLOR[u.role]} 15%, transparent)`, color:ROLE_COLOR[u.role], padding:'3px 9px', borderRadius:'var(--pg-r-sm)', fontSize:11, fontWeight:600 }}>{u.role}</span>
                </td>
                <td style={{ padding:'12px 16px', fontSize:13, color:'var(--pg-ink-2)', fontFamily:'var(--pg-font-mono)' }}>{u.email}</td>
                <td style={{ padding:'12px 16px', fontSize:12, color:'var(--pg-ink-3)' }}>{u.last}</td>
                <td style={{ padding:'12px 16px' }}>
                  <span style={{ display:'flex', alignItems:'center', gap:5 }}>
                    <span style={{ width:7, height:7, borderRadius:'50%', background:u.status==='active'?'var(--pg-green)':'var(--pg-border-strong)', display:'inline-block' }} />
                    <span style={{ fontSize:12, color:u.status==='active'?'var(--pg-green)':'var(--pg-ink-3)', textTransform:'capitalize', fontWeight:500 }}>{u.status}</span>
                  </span>
                </td>
                <td style={{ padding:'12px 16px' }}>
                  <div style={{ display:'flex', gap:6 }}>
                    <button style={{ padding:'4px 10px', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-sm)', background:'var(--pg-surface)', fontSize:11, cursor:'pointer' }}>Edit</button>
                    <button style={{ padding:'4px 10px', border:'1px solid var(--pg-tint-red)', borderRadius:'var(--pg-r-sm)', background:'var(--pg-tint-red)', color:'var(--pg-red)', fontSize:11, cursor:'pointer' }}>Remove</button>
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

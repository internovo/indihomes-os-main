import React from 'react'
import ModuleHeader from '../shared/ModuleHeader.jsx'
import { LEADS } from '../../data/leads.js'

const FACTORS = [
  { label:'Budget alignment', weight:28, color:'var(--pg-surface-dark)' },
  { label:'Engagement level', weight:22, color:'var(--pg-green)' },
  { label:'Location match', weight:18, color:'var(--pg-gold)' },
  { label:'Intent signals', weight:17, color:'var(--pg-indigo-light)' },
  { label:'Profile quality', weight:15, color:'var(--pg-red)' },
]

const SCORED = [
  { name:'Rahul Mehta', project:'Lodha Amara', score:91, temp:'hot' },
  { name:'Amit Sharma', project:'Lodha Amara', score:82, temp:'hot' },
  { name:'Vikram Rao', project:'Godrej RKS', score:88, temp:'hot' },
  { name:'Meena Iyer', project:'Oberoi Eternia', score:77, temp:'hot' },
  { name:'Suresh Patel', project:'Piramal Vaikunth', score:67, temp:'warm' },
  { name:'Deepa Singh', project:'Shapoorji Joyville', score:54, temp:'warm' },
  { name:'Priya Nair', project:'Godrej Hillside', score:45, temp:'warm' },
  { name:'Kavita Joshi', project:'Kalpataru Vista', score:38, temp:'cold' },
]

const SCORE_COLOR = s => s>=75?'var(--pg-green)': s>=45?'var(--pg-gold)':'var(--pg-indigo-light)'

export default function LeadScoring() {
  return (
    <div style={{ padding:'28px 32px', maxWidth:1280 }}>
      <ModuleHeader module="MODULE 08" title="Lead Scoring" subtitle="AI scores every lead on 5 factors in real-time" />
      {/* Buckets */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:16, marginBottom:28 }}>
        {[['🔥 HOT','1,840','score ≥ 75','var(--pg-tint-red)','var(--pg-red)'],['🌤 WARM','4,300','score 45–74','var(--pg-tint-amber)','var(--pg-gold)'],['❄ COLD','6,340','score < 45','var(--pg-tint-indigo-2)','var(--pg-indigo-light)']].map(([label,count,range,bg,color])=>(
          <div key={label} style={{ background:bg, border:`1px solid ${color}`, borderRadius:'var(--pg-r-xl)', padding:'22px', textAlign:'center' }}>
            <div style={{ fontSize:20, fontWeight:800, color, marginBottom:4 }}>{label}</div>
            <div style={{ fontSize:36, fontWeight:800, color:'var(--pg-ink)' }}>{count}</div>
            <div style={{ fontSize:12, color:'var(--pg-ink-2)' }}>{range}</div>
          </div>
        ))}
      </div>
      {/* Two cols */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 320px', gap:20 }}>
        {/* Scored leads */}
        <div style={{ background:'var(--pg-surface)', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-xl)', overflow:'hidden' }}>
          <div style={{ padding:'14px 20px', borderBottom:'1px solid var(--pg-border)', fontWeight:700, fontSize:15 }}>Lead Score List</div>
          {SCORED.map((l,i)=>(
            <div key={l.name} style={{ display:'flex', alignItems:'center', gap:14, padding:'12px 20px', borderBottom:'1px solid var(--pg-border)' }}>
              <div style={{ width:36, height:36, borderRadius:'50%', background:`color-mix(in srgb, ${SCORE_COLOR(l.score)} 13%, transparent)`, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, fontSize:14, color:SCORE_COLOR(l.score), flexShrink:0 }}>{l.score}</div>
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:600, fontSize:13 }}>{l.name}</div>
                <div style={{ fontSize:11, color:'var(--pg-ink-2)' }}>{l.project}</div>
              </div>
              <div style={{ flex:2 }}>
                <div style={{ height:8, background:'var(--pg-surface-sunken)', borderRadius:4, overflow:'hidden' }}>
                  <div style={{ width:`${l.score}%`, height:'100%', background:SCORE_COLOR(l.score), borderRadius:4 }} />
                </div>
              </div>
              <div style={{ width:60, textAlign:'right' }}>
                <span style={{ fontSize:11, fontWeight:600, color:SCORE_COLOR(l.score), background:`color-mix(in srgb, ${SCORE_COLOR(l.score)} 15%, transparent)`, padding:'3px 8px', borderRadius:20 }}>{l.temp}</span>
              </div>
            </div>
          ))}
        </div>
        {/* Model breakdown */}
        <div>
          <div style={{ background:'var(--pg-surface)', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-xl)', padding:'20px', marginBottom:16 }}>
            <div style={{ fontWeight:700, fontSize:14, marginBottom:16 }}>Scoring Model</div>
            <div style={{ width:'100%', height:140, display:'flex', alignItems:'center', justifyContent:'center', background:'var(--pg-shell)', borderRadius:10, marginBottom:16, position:'relative' }}>
              <div style={{ position:'relative', width:100, height:100 }}>
                <svg viewBox="0 0 100 100" style={{ width:100, height:100, transform:'rotate(-90deg)' }}>
                  {FACTORS.reduce((acc,f,i)=>{
                    const startAngle = acc.angle
                    const angle = (f.weight/100)*360
                    const r=40, cx=50, cy=50
                    const x1=cx+r*Math.cos(startAngle*Math.PI/180)
                    const y1=cy+r*Math.sin(startAngle*Math.PI/180)
                    const x2=cx+r*Math.cos((startAngle+angle)*Math.PI/180)
                    const y2=cy+r*Math.sin((startAngle+angle)*Math.PI/180)
                    const large=angle>180?1:0
                    acc.els.push(<path key={f.label} d={`M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2} Z`} fill={f.color} />)
                    acc.angle += angle
                    return acc
                  },{els:[],angle:0}).els}
                </svg>
              </div>
            </div>
            {FACTORS.map(f=>(
              <div key={f.label} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                <div style={{ width:10, height:10, borderRadius:2, background:f.color, flexShrink:0 }} />
                <span style={{ fontSize:12, flex:1, color:'var(--pg-ink-2)' }}>{f.label}</span>
                <span style={{ fontSize:12, fontWeight:700, fontFamily:'var(--pg-font-mono)' }}>{f.weight}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

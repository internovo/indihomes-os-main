import React from 'react'
import ModuleHeader from '../shared/ModuleHeader.jsx'

const COLUMNS = [
  { id:'new', label:'New Lead', dot:'var(--pg-indigo-light)', count:328, cards:[
    { name:'Kartik Bose', score:72, project:'Lodha Amara', time:'1m ago' },
    { name:'Sona Menon', score:58, project:'Kalpataru Vista', time:'4m ago' },
  ]},
  { id:'contacted', label:'Contacted', dot:'var(--pg-gold)', count:184, cards:[
    { name:'Amit Sharma', score:82, project:'Lodha Amara', time:'2h ago' },
    { name:'Priya Nair', score:45, project:'Godrej Hillside', time:'5h ago' },
  ]},
  { id:'visit', label:'Site Visit', dot:'var(--pg-indigo)', count:67, cards:[
    { name:'Vikram Rao', score:88, project:'Godrej RKS', time:'Today' },
    { name:'Meena Iyer', score:77, project:'Oberoi Eternia', time:'Yesterday' },
  ]},
  { id:'negotiation', label:'Negotiation', dot:'var(--pg-gold)', count:23, cards:[
    { name:'Rajesh Kumar', score:90, project:'Lodha Amara', time:'3 days' },
    { name:'Anita Sharma', score:84, project:'Piramal Vaikunth', time:'5 days' },
  ]},
  { id:'booked', label:'Booked', dot:'var(--pg-green)', count:12, cards:[
    { name:'Suresh Patel', score:87, project:'Lodha Amara', time:'2 days' },
    { name:'Kavya Reddy', score:92, project:'Godrej RKS', time:'1 week' },
  ]},
  { id:'lost', label:'Lost', dot:'var(--pg-red)', count:45, cards:[
    { name:'Deepa Singh', score:54, project:'Shapoorji Joyville', time:'3 days' },
    { name:'Rohit Nair', score:41, project:'Kalpataru Vista', time:'1 week' },
  ]},
]

const SCORE_COLOR = s => s>=75?'var(--pg-green)':s>=45?'var(--pg-gold)':'var(--pg-indigo-light)'

export default function SalesCRM() {
  return (
    <div style={{ padding:'28px 32px', maxWidth:1400 }}>
      <ModuleHeader module="MODULE 14" title="Lead Pipeline" subtitle="Drag cards to advance · AI auto-moves on qualification signals" />
      <div style={{ display:'flex', gap:14, overflowX:'auto', paddingBottom:12 }}>
        {COLUMNS.map(col=>(
          <div key={col.id} style={{ minWidth:210, flex:'0 0 210px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:10, padding:'0 2px' }}>
              <span style={{ width:10, height:10, borderRadius:'50%', background:col.dot, display:'inline-block' }} />
              <span style={{ fontWeight:700, fontSize:13 }}>{col.label}</span>
              <span style={{ marginLeft:'auto', background:'var(--pg-shell)', color:'var(--pg-ink-2)', padding:'2px 8px', borderRadius:20, fontSize:11, fontWeight:600 }}>{col.count}</span>
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {col.cards.map((card,i)=>(
                <div key={i} style={{ background:'var(--pg-surface)', border:'1px solid var(--pg-border)', borderRadius:10, padding:'12px', cursor:'grab' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:6 }}>
                    <div style={{ fontWeight:600, fontSize:13 }}>{card.name}</div>
                    <span style={{ background:`color-mix(in srgb, ${SCORE_COLOR(card.score)} 15%, transparent)`, color:SCORE_COLOR(card.score), padding:'2px 7px', borderRadius:20, fontSize:10, fontWeight:700 }}>{card.score}</span>
                  </div>
                  <div style={{ fontSize:11, color:'var(--pg-ink-2)' }}>{card.project}</div>
                  <div style={{ fontSize:10, color:'var(--pg-ink-3)', marginTop:6 }}>{card.time}</div>
                </div>
              ))}
              <button style={{ width:'100%', padding:'8px', border:'1px dashed var(--pg-border)', borderRadius:10, background:'transparent', color:'var(--pg-ink-3)', fontSize:12, cursor:'pointer' }}>+ Add card</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

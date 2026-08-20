import React, { useState } from 'react'
import ModuleHeader from '../shared/ModuleHeader.jsx'
import Chip from '../shared/Chip.jsx'

const ASSET_TYPES = ['Meta creative','Landing page','WhatsApp creative','Email']
const LANGUAGES = ['English','Hindi','Marathi']
const TONES = ['Urgency','Premium','Affordable']

// a.color: Meta creative keeps Meta's real brand blue (external identity);
// the other two asset types use propOG's own palette since they're our own
// generated-asset categories, not third-party brand marks.
const ASSETS = [
  { type:'Meta Creative', desc:'3 BHK · ₹1.95 Cr · Thane', tag:'1080×1080', color:'#1877F2', emoji:'🖼' },
  { type:'Landing Page', desc:'Lodha Amara Campaign Page', tag:'Web', color:'var(--pg-green)', emoji:'🌐' },
  { type:'WhatsApp Template', desc:'Welcome + brochure flow', tag:'WhatsApp', color:'#25D366', emoji:'💬' },
]

export default function CreativeStudio() {
  const [assets, setAssets] = useState(['Meta creative','Landing page'])
  const [langs, setLangs] = useState(['English'])
  const [tones, setTones] = useState(['Urgency'])
  const [generating, setGenerating] = useState(false)
  const [generated, setGenerated] = useState(true)

  const toggleArr = (arr, setArr, val) => setArr(a => a.includes(val) ? a.filter(x=>x!==val) : [...a,val])

  const generate = () => {
    setGenerating(true)
    setTimeout(()=>{ setGenerating(false); setGenerated(true) }, 1800)
  }

  return (
    <div style={{ padding:'28px 32px', maxWidth:1280 }}>
      <ModuleHeader module="MODULE 05" title="Creative AI Studio" />
      <div style={{ display:'grid', gridTemplateColumns:'320px 1fr', gap:24 }}>
        {/* Left panel */}
        <div style={{ background:'var(--pg-surface)', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-2xl)', padding:'22px', height:'fit-content' }}>
          <div style={{ fontSize:14, fontWeight:700, marginBottom:16 }}>Generate assets</div>
          <div style={{ marginBottom:16 }}>
            <label style={{ fontSize:11, color:'var(--pg-ink-3)', fontFamily:'var(--pg-font-mono)', letterSpacing:'0.08em', display:'block', marginBottom:6 }}>PROJECT</label>
            <select style={{ width:'100%', padding:'8px 12px', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-md)', fontSize:13, background:'var(--pg-shell)', color:'var(--pg-ink)' }}>
              <option>Lodha Amara — 3 BHK</option>
              <option>Godrej Emerald — 2 BHK</option>
              <option>Kalpataru Vista — 3 BHK</option>
            </select>
          </div>
          <div style={{ marginBottom:16 }}>
            <label style={{ fontSize:11, color:'var(--pg-ink-3)', fontFamily:'var(--pg-font-mono)', letterSpacing:'0.08em', display:'block', marginBottom:8 }}>ASSET TYPE</label>
            <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
              {ASSET_TYPES.map(a=><Chip key={a} label={a} active={assets.includes(a)} onClick={()=>toggleArr(assets,setAssets,a)} />)}
            </div>
          </div>
          <div style={{ marginBottom:16 }}>
            <label style={{ fontSize:11, color:'var(--pg-ink-3)', fontFamily:'var(--pg-font-mono)', letterSpacing:'0.08em', display:'block', marginBottom:8 }}>LANGUAGE</label>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
              {LANGUAGES.map(l=><Chip key={l} label={l} active={langs.includes(l)} onClick={()=>toggleArr(langs,setLangs,l)} />)}
            </div>
          </div>
          <div style={{ marginBottom:20 }}>
            <label style={{ fontSize:11, color:'var(--pg-ink-3)', fontFamily:'var(--pg-font-mono)', letterSpacing:'0.08em', display:'block', marginBottom:8 }}>TONE</label>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
              {TONES.map(t=><Chip key={t} label={t} active={tones.includes(t)} onClick={()=>toggleArr(tones,setTones,t)} />)}
            </div>
          </div>
          <button onClick={generate} disabled={generating} style={{ width:'100%', padding:'12px', background:'var(--pg-surface-dark)', color:'var(--pg-on-dark)', border:'none', borderRadius:'var(--pg-r-xl)', fontSize:14, fontWeight:700, cursor:'pointer', opacity:generating?0.7:1 }}>
            {generating ? '⏳ Generating...' : '✦ Generate assets'}
          </button>
        </div>

        {/* Right panel */}
        <div>
          <div style={{ fontSize:13, color:'var(--pg-ink-2)', marginBottom:16 }}>
            {generated ? `${ASSETS.length} assets generated for Lodha Amara` : 'Configure and generate assets on the left'}
          </div>
          {generated && (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:16 }}>
              {ASSETS.map(a=>(
                <div key={a.type} style={{ background:'var(--pg-surface)', border:'1px solid var(--pg-border)', borderRadius:'var(--pg-r-xl)', overflow:'hidden' }}>
                  <div style={{ height:160, background:`linear-gradient(135deg,color-mix(in srgb, ${a.color} 13%, transparent),color-mix(in srgb, ${a.color} 27%, transparent))`, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:8 }}>
                    <div style={{ fontSize:40 }}>{a.emoji}</div>
                    <div style={{ fontSize:12, color:a.color, fontWeight:600, background:'var(--pg-surface)', padding:'2px 8px', borderRadius:4 }}>{a.tag}</div>
                  </div>
                  <div style={{ padding:'14px 16px' }}>
                    <div style={{ fontWeight:700, fontSize:13, marginBottom:4 }}>{a.type}</div>
                    <div style={{ fontSize:12, color:'var(--pg-ink-2)', marginBottom:12 }}>{a.desc}</div>
                    <div style={{ display:'flex', gap:8 }}>
                      <button style={{ flex:1, padding:'6px', background:'var(--pg-surface-dark)', color:'var(--pg-on-dark)', border:'none', borderRadius:6, fontSize:11, fontWeight:600, cursor:'pointer' }}>Download</button>
                      <button style={{ flex:1, padding:'6px', background:'var(--pg-surface)', color:'var(--pg-ink-2)', border:'1px solid var(--pg-border)', borderRadius:6, fontSize:11, cursor:'pointer' }}>Edit</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

import React from 'react'

export default function ModuleHeader({ module, title, subtitle, rightContent }) {
  return (
    <div style={{ marginBottom:28 }}>
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', flexWrap:'wrap', gap:12 }}>
        <div>
          {module && <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#8A8896', letterSpacing:'0.1em', textTransform:'uppercase', marginBottom:4 }}>{module}</div>}
          <h1 style={{ fontSize:26, fontWeight:800, color:'#1B1B3A', lineHeight:1.2 }}>{title}</h1>
          {subtitle && <p style={{ fontSize:14, color:'#75737F', marginTop:4 }}>{subtitle}</p>}
        </div>
        {rightContent && <div style={{ display:'flex', gap:10, alignItems:'center', flexShrink:0 }}>{rightContent}</div>}
      </div>
    </div>
  )
}
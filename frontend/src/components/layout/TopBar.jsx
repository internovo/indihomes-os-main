import React, { useState } from 'react'
import { Search, ChevronDown, Plus, Bell, Sparkles } from 'lucide-react'

const LABELS = {
  command:'Command Center', select:'Project Selection', project:'Project Intelligence',
  reco:'Campaign Recommendations', studio:'Creative AI Studio', deploy:'Campaign Deployment',
  capture:'Lead Capture', scoring:'Lead Scoring', junk:'Junk Detection',
  calling:'AI Calling Agent', whatsapp:'WhatsApp Agent', workforce:'AI Workforce',
  callers:'Caller Dashboard', crm:'Sales CRM', builder:'Builder Collaboration',
  analytics:'AI Analytics', recommend:'AI Recommendations', users:'User Management',
}

const iconBtn = {
  width: 38, height: 38, flexShrink: 0, background: 'var(--pg-surface)',
  border: '1px solid var(--pg-border)', borderRadius: 'var(--pg-r-lg)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
  color: 'var(--pg-ink-2)', position: 'relative',
}

export default function TopBar({ view, breadcrumbExtra }) {
  const [search, setSearch] = useState('')
  return (
    <div style={{
      height: 'var(--pg-topbar-h)', background: 'var(--pg-surface)', borderBottom: '1px solid var(--pg-border)',
      display: 'flex', alignItems: 'center', padding: '0 24px', gap: 10, flexShrink: 0,
      position: 'sticky', top: 0, zIndex: 50,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontFamily: 'var(--pg-font-mono)', fontSize: 10.5, color: 'var(--pg-ink-3)', letterSpacing: '1px' }}>
          propOG / {LABELS[view] || view}{breadcrumbExtra ? ` / ${breadcrumbExtra}` : ''}
        </span>
      </div>

      {/* Search — icon inset left */}
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <Search size={15} color="var(--pg-ink-4)" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search projects, leads, campaigns, agents…"
          style={{
            height: 38, background: 'var(--pg-shell)', border: '1px solid var(--pg-border)',
            borderRadius: 'var(--pg-r-xl)', padding: '0 14px 0 36px', fontSize: 13, width: 260,
            color: 'var(--pg-ink)', outline: 'none', fontFamily: 'var(--pg-font)',
          }}
          onFocus={e => { e.target.style.borderColor = 'var(--pg-gold)'; e.target.style.boxShadow = 'var(--pg-ring-gold)' }}
          onBlur={e => { e.target.style.borderColor = 'var(--pg-border)'; e.target.style.boxShadow = 'none' }}
        />
      </div>

      {/* Builder filter */}
      <button style={{
        height: 38, background: 'var(--pg-surface)', border: '1px solid var(--pg-border)',
        borderRadius: 'var(--pg-r-lg)', padding: '0 12px', display: 'flex', alignItems: 'center', gap: 7,
        fontSize: 12.5, fontWeight: 600, color: 'var(--pg-ink)', cursor: 'pointer', flexShrink: 0,
        fontFamily: 'var(--pg-font)', whiteSpace: 'nowrap',
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--pg-gold)', flexShrink: 0 }} />
        All Builders
        <ChevronDown size={13} color="var(--pg-ink-3)" />
      </button>

      <button style={iconBtn} title="Add">
        <Plus size={17} />
      </button>

      <button style={iconBtn} title="Notifications">
        <Bell size={16} />
        <span style={{ position: 'absolute', top: 8, right: 9, width: 6, height: 6, borderRadius: '50%', background: 'var(--pg-gold)' }} />
      </button>

      <button style={{
        height: 38, background: 'var(--pg-surface-dark)', color: 'var(--pg-on-dark)', border: 'none',
        borderRadius: 'var(--pg-r-lg)', padding: '0 15px', display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 12.5, fontWeight: 600, cursor: 'pointer', flexShrink: 0, fontFamily: 'var(--pg-font)', whiteSpace: 'nowrap',
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--pg-green)', flexShrink: 0 }} />
        Ask propOG AI
      </button>

      <div style={{
        width: 32, height: 32, borderRadius: '50%', background: 'var(--pg-surface-dark)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700,
        color: 'var(--pg-on-dark)', cursor: 'pointer', flexShrink: 0, fontFamily: 'var(--pg-font)',
      }}>A</div>
    </div>
  )
}

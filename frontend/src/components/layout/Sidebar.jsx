import React from 'react'
import {
  LayoutDashboard, Search, Building2, Target, Palette, Rocket,
  UserPlus, TrendingUp, Trash2, Phone, MessageCircle, Users,
  Headphones, Briefcase, HardHat, BarChart3, Lightbulb, UserCog,
} from 'lucide-react'
import Logomark from '../ui/Logomark.jsx'

const NAV_GROUPS = [
  { label: 'OVERVIEW', items: [
    { id: 'command', name: 'Command Center', mod: '01', icon: LayoutDashboard },
  ]},
  { label: 'INTELLIGENCE', items: [
    { id: 'select', name: 'Project Selection', mod: '02', icon: Search },
    { id: 'project', name: 'Project Intelligence', mod: '03', icon: Building2 },
    { id: 'reco', name: 'Campaign Recommendations', mod: '04', icon: Target },
  ]},
  { label: 'CREATIVE & DEPLOY', items: [
    { id: 'studio', name: 'Creative AI Studio', mod: '05', icon: Palette },
    { id: 'deploy', name: 'Campaign Deployment', mod: '06', icon: Rocket },
  ]},
  { label: 'LEADS', items: [
    { id: 'capture', name: 'Lead Capture', mod: '07', icon: UserPlus },
    { id: 'scoring', name: 'Lead Scoring', mod: '08', icon: TrendingUp },
    { id: 'junk', name: 'Junk Detection', mod: '09', icon: Trash2 },
  ]},
  { label: 'AI AGENTS', items: [
    { id: 'calling', name: 'AI Calling Agent', mod: '10', icon: Phone },
    { id: 'whatsapp', name: 'WhatsApp Agent', mod: '11', icon: MessageCircle },
    { id: 'workforce', name: 'AI Workforce', mod: '12', icon: Users },
  ]},
  { label: 'TEAM PERFORMANCE', items: [
    { id: 'callers', name: 'Caller Dashboard', mod: '13', icon: Headphones },
  ]},
  { label: 'SALES', items: [
    { id: 'crm', name: 'Sales CRM', mod: '14', icon: Briefcase },
    { id: 'builder', name: 'Builder Collaboration', mod: '15', icon: HardHat },
  ]},
  { label: 'REPORTS', items: [
    { id: 'analytics', name: 'AI Analytics', mod: '16', icon: BarChart3 },
    { id: 'recommend', name: 'Recommendations', mod: '17', icon: Lightbulb },
  ]},
  { label: 'ADMINISTRATION', items: [
    { id: 'users', name: 'User Management', mod: '18', icon: UserCog },
  ]},
]

export default function Sidebar({ active, setView }) {
  return (
    <div style={{
      width: 'var(--pg-sidebar-w)', flexShrink: 0, background: 'var(--pg-sidebar-bg)',
      borderRight: '1px solid var(--pg-border)', display: 'flex', flexDirection: 'column',
      height: '100vh', position: 'sticky', top: 0,
    }}>
      {/* Logo row */}
      <div style={{
        height: 'var(--pg-topbar-h)', padding: '0 16px', flexShrink: 0,
        borderBottom: '1px solid var(--pg-border)', display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <Logomark size={28} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--pg-ink)', letterSpacing: '-0.4px', lineHeight: 1, fontFamily: 'var(--pg-font)' }}>
            propOG
          </div>
          <span style={{
            fontFamily: 'var(--pg-font-mono)', fontSize: 8.5, letterSpacing: '0.5px',
            color: 'var(--pg-gold-deep)', background: 'var(--pg-gold-tint)',
            borderRadius: 'var(--pg-r-xs)', padding: '3px 6px', lineHeight: 1,
          }}>OS</span>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', scrollbarWidth: 'thin' }}>
        {NAV_GROUPS.map(g => (
          <div key={g.label} style={{ marginBottom: 4 }}>
            <div style={{
              padding: '4px 10px 7px', fontSize: 9.5, fontFamily: 'var(--pg-font-mono)',
              color: 'var(--pg-ink-3)', letterSpacing: '1.2px', textTransform: 'uppercase',
            }}>{g.label}</div>
            {g.items.map(item => {
              const isActive = active === item.id
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  onClick={() => setView(item.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%', height: 32,
                    padding: '8px 10px', marginBottom: 1,
                    background: isActive ? 'var(--pg-gold-tint)' : 'transparent',
                    color: isActive ? 'var(--pg-ink)' : 'var(--pg-nav-ink)',
                    border: 'none', borderRadius: 'var(--pg-r-lg)', cursor: 'pointer', textAlign: 'left',
                    fontFamily: 'var(--pg-font)', fontSize: 12.5, fontWeight: isActive ? 700 : 500,
                    transition: 'background 0.15s, color 0.15s',
                  }}
                  onMouseEnter={e => { if (!isActive) { e.currentTarget.style.background = 'var(--pg-sidebar-hover)'; e.currentTarget.style.color = 'var(--pg-ink)' } }}
                  onMouseLeave={e => { if (!isActive) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--pg-nav-ink)' } }}
                >
                  <Icon size={16} strokeWidth={1.6} color={isActive ? 'var(--pg-gold)' : 'currentColor'} style={{ flexShrink: 0 }} />
                  <span style={{ flex: 1, lineHeight: 1.3 }}>{item.name}</span>
                  {isActive && (
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--pg-green)', flexShrink: 0 }} />
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </nav>

      {/* User chip — stays dark, the anchor of the light sidebar */}
      <div style={{
        margin: '10px 12px 12px', padding: '10px 12px', background: 'var(--pg-surface-dark)',
        borderRadius: 12, display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flexShrink: 0,
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: 9, background: 'var(--pg-gold)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 800, color: 'var(--pg-surface-dark)', flexShrink: 0,
          fontFamily: 'var(--pg-font)',
        }}>A</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--pg-on-dark)', fontFamily: 'var(--pg-font)' }}>Aarti Rawat</div>
          <div style={{ fontSize: 10.5, fontWeight: 500, color: 'rgba(255,255,255,0.55)', fontFamily: 'var(--pg-font)' }}>Super Admin</div>
        </div>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0 }}>
          <path d="M4 2.5L7.5 6L4 9.5" stroke="rgba(255,255,255,0.45)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  )
}

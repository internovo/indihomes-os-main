import React, { useState, useEffect, useCallback } from 'react'
import ModuleHeader from '../shared/ModuleHeader.jsx'
import { MessageCircle, Phone, ChevronDown, MessageSquarePlus, ExternalLink, Info, Check, X } from 'lucide-react'
import SectionCard from '../ui/SectionCard.jsx'
import ProtectedField, { Field } from '../ui/ProtectedField.jsx'
import EditableFieldShared from '../ui/EditableField.jsx'
import StatusPill from '../ui/StatusPill.jsx'
import { EmptyValue } from '../ui/EmptyState.jsx'
import { colors } from '../ui/tokens.js'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'

// The lifecycle stages a lead actually moves through in this CRM — leads.status
// is a free-text column (no DB-level enum) so this is a UI-level vocabulary,
// not a schema constraint; a lead created before this list existed may still
// carry an older value (e.g. "Visited"/"Junk") until manually updated via
// StatusEditor, and falls back to a neutral color rather than erroring.
const STATUS_OPTIONS = ['New', 'Contacted', 'Qualified', 'Follow-up', 'Site Visit Scheduled', 'Site Visit Completed', 'Negotiation', 'Won', 'Lost']
const STATUS_COLOR = {
  New: '#0E0E52', Contacted: '#F7941D', Qualified: '#0E5FBF', 'Follow-up': '#6B4FBB',
  'Site Visit Scheduled': '#0E9CBF', 'Site Visit Completed': '#156B35', Negotiation: '#C77D19',
  Won: '#0B8043', Lost: '#D64545',
}
const SOURCE_LABEL = { housing: 'Housing.com', meta: 'Meta Ad', website: 'IndiHomes Website', manual: 'IndiHomes OS', '99acres': '99acres', magicbricks: 'MagicBricks', referral: 'CP Referral', walkin: 'Walk-in' }
// A small color-coded dot beats a full pill for a field that appears on
// every row — enough to scan a column by color without the visual weight of
// a badge per row (the table already has Status + CRM as real pills; a
// third pill column would be the "unnecessary pills everywhere" the spec
// warns against).
const SOURCE_COLOR = { housing:'#8B1A1A', meta:'#0E5FBF', website:'#2E9E4F', manual:'#8A8896', '99acres':'#156B35', magicbricks:'#BE1E2D', referral:'#6B4FBB', walkin:'#F7941D' }

// Qualification sub-status taxonomy — MUST stay in sync with
// backend/qualification.cjs's TAXONOMY (same dual-copy convention already
// used for business_hours.py across the two chatbot repos; see either
// repo's claude.md, "If business_hours.py is ever edited in one project,
// mirror the change in the other"). Keyed by the SAME STATUS_OPTIONS
// vocabulary above — a lead's sub-status choices depend on its current
// status (e.g. "Out of budget" only makes sense once status is "Lost").
const QUALIFICATION_TAXONOMY = {
  New: [],
  Contacted: ['Ringing', 'Not reachable', 'Call back later'],
  Qualified: ['Budget match', 'Site visit interested', 'Ready to buy'],
  'Follow-up': ['Awaiting reply', 'Scheduled callback'],
  'Site Visit Scheduled': ['Confirmed', 'Rescheduled'],
  'Site Visit Completed': ['Positive', 'Needs follow-up'],
  Negotiation: ['Price discussion', 'Documentation'],
  Won: ['Booked', 'Agreement signed'],
  Lost: ['Out of budget', 'Wrong location', 'Just browsing', 'Broker/agent', 'Wrong number', 'Not interested'],
}

function timeAgo(ts) {
  if (!ts) return '—'
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// Manual lead-entry form — the "IndiHomes OS" source: a CP/agent capturing a
// walk-in or phone enquiry directly, rather than a Meta/Housing.com sync.
const ADD_LEAD_FIELDS = [
  { key: 'name', label: 'Name', ph: 'Full name' },
  { key: 'phone', label: 'Phone *', ph: '10-digit mobile', req: true },
  { key: 'email', label: 'Email', ph: 'name@example.com' },
  { key: 'project', label: 'Project', ph: 'Which project are they asking about?' },
  { key: 'budget', label: 'Budget', ph: 'e.g. ₹1.2 Cr – 1.5 Cr' },
  { key: 'configuration', label: 'Configuration', ph: 'e.g. 2 BHK' },
  { key: 'location', label: 'Location', ph: 'e.g. Goregaon West' },
]

function AddLeadModal({ onClose, onSubmit }) {
  const [f, setF] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState(null)
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }))
  const canSubmit = (f.phone || '').replace(/\D/g, '').length >= 10

  const submit = async () => {
    if (!canSubmit || submitting) return
    setSubmitting(true); setErr(null)
    try {
      await onSubmit(f)
      onClose()
    } catch (e) { setErr(e.message) }
    finally { setSubmitting(false) }
  }

  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(14,14,40,0.45)', zIndex:200, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background:'#fff', borderRadius:16, width:520, maxWidth:'100%', maxHeight:'90vh', overflowY:'auto', padding:'26px 30px', boxShadow:'0 24px 64px rgba(0,0,0,0.25)' }}>
        <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:16 }}>
          <div>
            <div style={{ fontSize:17, fontWeight:800, color:'#1B1B3A' }}>＋ Add Lead</div>
            <div style={{ fontSize:12.5, color:'#75737F', marginTop:2 }}>Captured directly in IndiHomes OS — labeled source "IndiHomes OS".</div>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', fontSize:20, color:'#8A8896', cursor:'pointer', lineHeight:1 }}>×</button>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
          {ADD_LEAD_FIELDS.map(field => (
            <div key={field.key}>
              <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#4A4A63', marginBottom:5 }}>{field.label}</label>
              <input value={f[field.key] || ''} onChange={e => set(field.key, e.target.value)} placeholder={field.ph}
                style={{ width:'100%', padding:'9px 12px', border:'1px solid #E9E7E0', borderRadius:8, fontSize:13, fontFamily:"'Plus Jakarta Sans',sans-serif", outline:'none', boxSizing:'border-box' }} />
            </div>
          ))}
        </div>
        {err && <div style={{ marginTop:12, fontSize:12.5, color:'#D64545' }}>{err}</div>}
        <div style={{ marginTop:20, display:'flex', gap:10, justifyContent:'flex-end' }}>
          <button onClick={onClose} style={{ padding:'9px 18px', background:'#F6F5F1', color:'#4A4A63', border:'none', borderRadius:8, fontSize:13, fontWeight:600, cursor:'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={!canSubmit || submitting}
            style={{ padding:'9px 20px', background: canSubmit ? '#0E0E52' : '#ccc', color:'#fff', border:'none', borderRadius:8, fontSize:13, fontWeight:700, cursor: canSubmit && !submitting ? 'pointer' : 'not-allowed' }}>
            {submitting ? '⟳ Saving…' : 'Add lead'}
          </button>
        </div>
      </div>
    </div>
  )
}

// Day-bucket label for the activity feed — "Today"/"Yesterday"/a real date,
// so a scrolling list of raw timestamps groups into something a human scans
// quickly.
function dayLabel(ts) {
  const d = new Date(ts), now = new Date()
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86400000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined })
}

const TOUCH_SOURCE_LABEL = { ...SOURCE_LABEL, manual: 'IndiHomes OS' }
const EDIT_FIELD_LABEL = { project:'Project', budget:'Budget', configuration:'Configuration', location:'Location', email:'Email', possession_date:'Possession date', amenities:'Amenities', notes:'Notes', status:'Status', sub_status:'Sub-status', qualification:'Meta qualification' }
function fmtEditValue(v) { return v == null || v === '' ? '(empty)' : v }

// SectionCard/Card — see src/components/ui/SectionCard.jsx (imported
// above), the same shared card shape ProjectIntelligence/Project Selection
// use, so every screen's "bordered card with a label header" looks
// pixel-identical rather than each screen having its own near-duplicate.

// Unified chronological activity feed — merges lead_touches (real intake
// events) and lead_edits (real field-edit audit log) into ONE timeline
// sorted by timestamp, grouped by day. Same dot+bold-lead-in+muted-detail
// row shape for both event kinds; only the dot color and lead-in text
// differ (green/grey = touch, purple = edit) — previously these were two
// separately-styled lists stacked on top of each other.
function ActivityDot({ color }) {
  return <span style={{ width:7, height:7, borderRadius:'50%', background:color, marginTop:5, flexShrink:0 }} />
}
function timeOf(ts) { return new Date(ts).toLocaleTimeString('en-IN', { hour:'numeric', minute:'2-digit' }) }

function ActivityFeed({ touches, edits }) {
  const items = [
    ...touches.map(t => ({ at: t.received_at, node: (
      <div style={{ display:'flex', gap:10, alignItems:'flex-start', fontSize:13 }}>
        <ActivityDot color={t.is_duplicate ? '#C8C6D0' : '#2E9E4F'} />
        <div>
          <span style={{ color:'#1B1B3A', fontWeight:600 }}>{t.is_duplicate ? 'Repeat enquiry' : 'New lead captured'} via {TOUCH_SOURCE_LABEL[t.source] || t.source}</span>
          <span style={{ color:'#8A8896' }}> · {timeOf(t.received_at)}</span>
        </div>
      </div>
    ) })),
    ...edits.map(e => {
      // Follow-up notes and status changes are both logged through the same
      // lead_edits audit table as every other field edit, but read more
      // naturally as their own sentence shape than a generic "X updated —
      // old → new" line (a follow-up has no meaningful "old value", and a
      // status change reads better as "changed to Y" than "old → new").
      if (e.field === 'follow_up') {
        return { at: e.edited_at, node: (
          <div style={{ display:'flex', gap:10, alignItems:'flex-start', fontSize:13 }}>
            <ActivityDot color="#F7941D" />
            <div>
              <span style={{ color:'#1B1B3A', fontWeight:600 }}>Follow-up added</span>
              <span style={{ color:'#8A8896' }}> · {timeOf(e.edited_at)}</span>
              <div style={{ color:'#4A4A63', marginTop:2, background:'#FBFAF7', border:'1px solid #EEEBE3', borderRadius:6, padding:'6px 9px' }}>{e.new_value}</div>
            </div>
          </div>
        ) }
      }
      if (e.field === 'status') {
        return { at: e.edited_at, node: (
          <div style={{ display:'flex', gap:10, alignItems:'flex-start', fontSize:13 }}>
            <ActivityDot color={STATUS_COLOR[e.new_value] || '#6B4FBB'} />
            <div>
              <span style={{ color:'#1B1B3A', fontWeight:600 }}>Status changed to {fmtEditValue(e.new_value)}</span>
              {e.old_value && <span style={{ color:'#8A8896' }}> from {e.old_value}</span>}
              <span style={{ color:'#8A8896' }}> · {timeOf(e.edited_at)}</span>
            </div>
          </div>
        ) }
      }
      return { at: e.edited_at, node: (
        <div style={{ display:'flex', gap:10, alignItems:'flex-start', fontSize:13 }}>
          <ActivityDot color="#6B4FBB" />
          <div>
            <span style={{ color:'#1B1B3A', fontWeight:600 }}>{EDIT_FIELD_LABEL[e.field] || e.field} updated</span>
            <span style={{ color:'#8A8896' }}> — {fmtEditValue(e.old_value)} → {fmtEditValue(e.new_value)} · {timeOf(e.edited_at)}</span>
          </div>
        </div>
      ) }
    }),
  ].sort((a, b) => b.at - a.at)

  if (!items.length) return <div style={{ fontSize:13, color:'#8A8896' }}>No activity recorded yet.</div>

  const groups = []
  for (const it of items) {
    const label = dayLabel(it.at)
    let g = groups.find(g => g.label === label)
    if (!g) { g = { label, items: [] }; groups.push(g) }
    g.items.push(it)
  }
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      {groups.map(g => (
        <div key={g.label}>
          <div style={{ fontSize:10.5, fontWeight:700, color:'#8A8896', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:8 }}>{g.label}</div>
          <div style={{ display:'flex', flexDirection:'column', gap:9 }}>
            {g.items.map((it, i) => <React.Fragment key={i}>{it.node}</React.Fragment>)}
          </div>
        </div>
      ))}
    </div>
  )
}

// WhatsApp Bot / AI Calling Agent summary card. Neither conversation store
// exists yet (server.cjs's two endpoints are honest stubs) — this always
// shows a real "not connected" empty state (icon + short reason, matching
// Project Intelligence's EmptyState pattern) rather than an error or
// fabricated sample messages. "View Details" is a real button, always
// clickable (so the honest state is one click away, never hidden), styled
// muted when there's nothing to show yet and a stronger navy fill once a
// summary exists — so it reads as a real, waiting-for-data feature rather
// than dead UI.
function ConversationCard({ title, icon: Icon, summary, summaryAt, leadId, endpoint, kind }) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [hover, setHover] = useState(false)
  const hasSummary = !!summary

  const toggle = () => {
    if (open) { setOpen(false); return }
    setOpen(true)
    if (data) return
    setLoading(true)
    fetch(`${API}${endpoint}`).then(r => r.json()).then(setData)
      .catch(() => setData({ connected: false }))
      .finally(() => setLoading(false))
  }

  return (
    <div style={{ background:'#fff', border:'1px solid #E9E7E0', borderRadius:10, padding:'14px 16px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
        <Icon size={15} color="#0E0E52" strokeWidth={2} />
        <div style={{ fontSize:11, fontWeight:700, color:'#1B1B3A', textTransform:'uppercase', letterSpacing:'0.05em' }}>{title}</div>
      </div>
      {hasSummary ? (
        <>
          <div style={{ fontSize:13, color:'#1B1B3A', lineHeight:1.6, marginBottom:4 }}>{summary}</div>
          {summaryAt && <div style={{ fontSize:11, color:'#8A8896', marginBottom:12 }}>{timeAgo(summaryAt)}</div>}
        </>
      ) : (
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 0 14px', color:'#8A8896', fontSize:12.5 }}>
          <span style={{ fontSize:15, opacity:0.6 }}>—</span>
          <span>Not connected — no activity recorded for this lead yet.</span>
        </div>
      )}
      <button onClick={toggle}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        style={{
          display:'inline-flex', alignItems:'center', gap:6,
          padding:'6px 13px', borderRadius:7, fontSize:12, fontWeight:700, cursor:'pointer',
          fontFamily:"'Plus Jakarta Sans',sans-serif",
          border: '1px solid', borderColor: open || hasSummary ? '#0E0E52' : '#E9E7E0',
          background: open ? '#0E0E52' : hasSummary ? (hover ? '#1A1A6E' : '#0E0E52') : (hover ? '#F6F5F1' : '#fff'),
          color: open || hasSummary ? '#fff' : '#4A4A63',
          transition:'background-color 0.12s ease',
        }}>
        {open ? 'Hide Details' : 'View Details'}
        <ExternalLink size={12} strokeWidth={2.4} style={{ opacity:0.85 }} />
      </button>
      {open && (
        <div style={{ marginTop:10, background:'#F9F8F6', borderRadius:8, padding:'10px 12px' }}>
          {loading ? (
            <div style={{ fontSize:12, color:'#8A8896' }}>Loading…</div>
          ) : data?.connected ? (
            kind === 'whatsapp' ? (
              <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                {(data.messages || []).map((m, i) => (
                  <div key={i} style={{ fontSize:12, color:'#1B1B3A' }}><b>{m.direction === 'out' ? 'Bot' : 'Lead'}:</b> {m.text}</div>
                ))}
              </div>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                {(data.transcript || []).map((t, i) => (
                  <div key={i} style={{ fontSize:12, color:'#1B1B3A' }}><b>{t.speaker === 'agent' ? 'Agent' : 'Lead'}:</b> {t.text}</div>
                ))}
              </div>
            )
          ) : (
            <div style={{ fontSize:12, color:'#8A8896' }}>Conversation history isn't connected yet.</div>
          )}
        </div>
      )}
    </div>
  )
}

// ── AI Activity — WhatsApp/voice mascots with a tick, plus the horizontally
// scrollable status/sub-status strip (backend/qualification.cjs's
// classify() reads status+sub_status to decide qualified/disqualified,
// which is what gets reported to Meta CAPI for this lead — see
// backend/LEAD_EVENTS_INTEGRATION.md).
// ──────────────────────────────────────────────────────────────────────────

// One mascot circle (WhatsApp bot / AI voice agent) with a small tick/cross
// badge in the corner — 'ok' (green check) once that channel actually
// reached the lead (see db.cjs's getAiActivity for exactly what "reached"
// means per channel), 'failed' (red cross) if it tried and didn't connect,
// 'none' (grey dot, no icon) if nothing has happened yet. Deliberately
// THREE states, not a boolean — a missing tick and a confirmed failure are
// different operational facts (see this task's design conversation).
function MascotTick({ Icon, bg, state, label }) {
  const badgeColor = state === 'ok' ? '#2E9E4F' : state === 'failed' ? '#D64545' : '#C8C6D0'
  const BadgeIcon = state === 'ok' ? Check : state === 'failed' ? X : null
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:6 }}>
      <div style={{ position:'relative', width:44, height:44 }}>
        <div style={{ width:44, height:44, borderRadius:'50%', background:bg, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <Icon size={20} color="#fff" strokeWidth={2} />
        </div>
        <div style={{ position:'absolute', bottom:-2, right:-2, width:18, height:18, borderRadius:'50%', background:'#fff', border:`2px solid ${badgeColor}`, display:'flex', alignItems:'center', justifyContent:'center' }}>
          {BadgeIcon ? <BadgeIcon size={10} color={badgeColor} strokeWidth={3} /> : <span style={{ width:4, height:4, borderRadius:'50%', background:badgeColor }} />}
        </div>
      </div>
      <div style={{ fontSize:11, fontWeight:600, color:'#4A4A63', whiteSpace:'nowrap' }}>{label}</div>
    </div>
  )
}

// The horizontally-scrollable status/sub-status strip. Sub-status choices
// depend on the lead's CURRENT status (QUALIFICATION_TAXONOMY above) —
// changing status itself still goes through the existing StatusEditor in
// the Lead Overview card; this strip is for picking (or changing) the
// SUB-status once a status is set, via the same PATCH /api/leads/:id route
// (sending {status, sub_status} together — see
// backend/LEAD_EVENTS_INTEGRATION.md's server.cjs wiring for why both are
// sent, not just sub_status alone).
// Qualification pill — the one place that renders the lead's Meta
// qualification state (Part 3: must always be obvious, never a silent
// omission). Three honest states only, straight off the existing backend
// fields (qualification/qualification_source) — no fourth frontend-only
// value invented: Qualified, Disqualified, or (qualification missing/
// 'unknown') a neutral "Not yet classified" pill rather than nothing at all.
function QualificationBadge({ lead }) {
  if (lead.qualification === 'qualified' || lead.qualification === 'disqualified') {
    const qualified = lead.qualification === 'qualified'
    return (
      <span title={lead.qualification_source === 'human' ? 'Set by a human — locked against auto-changes' : 'Set automatically'}
        style={{
          fontSize:10.5, fontWeight:700, padding:'2px 8px', borderRadius:20,
          color: qualified ? '#156B35' : '#B02020',
          background: qualified ? '#2E9E4F18' : '#D6454518',
        }}>
        {qualified ? '✓ Qualified for Meta' : '✕ Disqualified for Meta'}
      </span>
    )
  }
  return (
    <span title="Status hasn't reached a qualifying or disqualifying stage yet"
      style={{ fontSize:10.5, fontWeight:700, padding:'2px 8px', borderRadius:20, color:'#75737F', background:'#F0EEE8' }}>
      ○ Not yet classified
    </span>
  )
}

// Click-to-open Sub Status dropdown — the exact same shape as StatusEditor
// above (pill + chevron, click to open a positioned menu, click-outside to
// close), backed by the SAME PATCH /api/leads/:id qualification-aware path.
// Always sends {status, sub_status} together (not sub_status alone) —
// matching this codebase's established convention (see
// LEAD_EVENTS_INTEGRATION.md's server.cjs wiring note) — but since both
// values already belong to the lead's CURRENT status, this can never
// produce an invalid status/sub-status combination; the only place that
// combination could go stale is a status-only change elsewhere, which
// server.cjs's PATCH handler now clears server-side (isValidSubStatus).
// Disabled (never opens) when the current status has no sub-status
// options at all — nothing to pick, so no affordance pretends otherwise.
function SubStatusEditor({ lead, onSaved }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const ref = React.useRef(null)
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const options = QUALIFICATION_TAXONOMY[lead.status] || []
  const hasOptions = options.length > 0
  const label = lead.sub_status || 'Not yet classified'
  const color = lead.sub_status ? '#0E0E52' : '#8B8BD6'

  const choose = async (next) => {
    if (next === lead.sub_status) { setOpen(false); return }
    setSaving(true); setErr(null)
    try {
      const res = await fetch(`${API}/api/leads/${lead.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: lead.status, sub_status: next }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      onSaved(j.lead)
      setOpen(false)
    } catch (e) { setErr(e.message) }
    finally { setSaving(false) }
  }

  return (
    <div ref={ref} style={{ position:'relative' }}>
      <button onClick={() => hasOptions && setOpen(o => !o)} disabled={saving || !hasOptions}
        title={hasOptions ? 'Change sub-status' : `No sub-statuses defined for "${lead.status || 'New'}"`}
        style={{ display:'flex', alignItems:'center', gap:4, background:'none', border:'none', padding:0, cursor: !hasOptions ? 'default' : saving ? 'wait' : 'pointer', opacity: hasOptions ? 1 : 0.6 }}>
        <StatusPill label={label} color={color} />
        {hasOptions && <ChevronDown size={13} strokeWidth={2.5} color={color} style={{ opacity:0.75 }} />}
      </button>
      {open && hasOptions && (
        <div style={{ position:'absolute', top:'120%', left:0, zIndex:40, background:'#fff', border:'1px solid #E9E7E0', borderRadius:9, boxShadow:'0 10px 28px rgba(16,24,40,0.14)', padding:5, minWidth:200 }}>
          {options.map(opt => {
            const active = opt === lead.sub_status
            return (
              <div key={opt} onClick={() => choose(opt)}
                style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 10px', borderRadius:6, fontSize:12.5, fontWeight:600, cursor:'pointer', color: active ? '#0E0E52' : '#4A4A63', background: active ? '#0E0E5212' : 'transparent' }}>
                <span style={{ width:7, height:7, borderRadius:'50%', background:'#0E0E52', flexShrink:0 }} />
                {opt}
              </div>
            )
          })}
        </div>
      )}
      {err && <div style={{ position:'absolute', top:'100%', left:0, marginTop:4, fontSize:11, color:'#D64545', whiteSpace:'nowrap' }}>{err}</div>}
    </div>
  )
}

// Status + Sub Status — both explicitly labeled and both editable in place,
// both using the SAME click-to-open dropdown shape (Status reuses
// StatusEditor; Sub Status uses the new SubStatusEditor above), both backed
// by the identical PATCH /api/leads/:id qualification-aware path — so
// either control goes through the same human-lock + qualification
// recalculation + Meta-dispatch pipeline, with no separate/duplicated
// logic anywhere in this component.
function QualificationStrip({ lead, onSaved }) {
  return (
    <div>
      <div style={{ display:'flex', alignItems:'flex-start', gap:28, flexWrap:'wrap' }}>
        <div>
          <div style={{ fontSize:11, fontWeight:700, color:'#8A8896', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:5 }}>Status</div>
          <StatusEditor lead={lead} onSaved={onSaved} />
        </div>
        <div>
          <div style={{ fontSize:11, fontWeight:700, color:'#8A8896', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:5 }}>Sub Status</div>
          <SubStatusEditor lead={lead} onSaved={onSaved} />
        </div>
        <div style={{ paddingTop:2 }}>
          <QualificationBadge lead={lead} />
        </div>
      </div>
    </div>
  )
}

// Mascots + qualification strip, fetched from GET /api/leads/:id/ai-activity
// (db.cjs's getAiActivity — see backend/LEAD_EVENTS_INTEGRATION.md). Shows
// an honest "no activity yet" state rather than fabricating a tick, same
// convention as ConversationCard above.
function AiActivityCard({ lead, onQualificationSaved }) {
  const [activity, setActivity] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`${API}/api/leads/${lead.id}/ai-activity`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setActivity(d) })
      .catch(() => { if (!cancelled) setActivity(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [lead.id])

  const waState = !activity ? 'none' : activity.whatsapp.failed ? 'failed' : activity.whatsapp.attempted ? 'ok' : 'none'
  const voiceState = !activity ? 'none' : activity.voice.failed ? 'failed' : activity.voice.connected ? 'ok' : 'none'

  return (
    <>
      <div style={{ display:'flex', gap:28, marginBottom:20, alignItems:'center' }}>
        <MascotTick Icon={MessageCircle} bg="#25D366" state={waState} label="WhatsApp bot" />
        <MascotTick Icon={Phone} bg="#0E0E52" state={voiceState} label="AI voice agent" />
        {loading && <span style={{ fontSize:12, color:'#8A8896' }}>Loading…</span>}
      </div>
      <QualificationStrip lead={lead} onSaved={onQualificationSaved} />
    </>
  )
}

// ── Lead Journey payload popover (Part 5) ───────────────────────────────────
// Human-friendly rendering of a lead_events.payload object — snake_case
// keys become Title Case, arrays join into one readable line, nested
// objects get a small indented sub-list, and anything credential-shaped
// (token/secret/password/auth/cookie/key) is shown as "[redacted]" rather
// than silently dropped, so it's visible that a field existed without ever
// leaking its value. Deliberately generic (iterates whatever keys the
// payload actually has) — this never invents a field the underlying event
// didn't send, it only reformats what's there.
const REDACTED_KEY_RE = /token|secret|password|auth|cookie|credential|api[_-]?key/i
function formatPayloadKey(k) {
  return String(k).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}
function formatPayloadValue(v) {
  if (v == null || v === '') return '—'
  if (Array.isArray(v)) return v.length ? v.map(formatPayloadValue).join(', ') : '—'
  if (typeof v === 'object') return null // rendered as its own nested block below, not inline
  return String(v)
}
function PayloadPopover({ payload }) {
  const entries = Object.entries(payload || {})
  if (!entries.length) return <div style={{ fontSize:12, color:'#8A8896', fontStyle:'italic' }}>Payload not available</div>
  return (
    <div style={{ maxHeight:220, overflowY:'auto', display:'flex', flexDirection:'column', gap:7 }}>
      {entries.map(([k, v]) => {
        const redacted = REDACTED_KEY_RE.test(k)
        const inline = redacted ? '[redacted]' : formatPayloadValue(v)
        return (
          <div key={k} style={{ fontSize:12 }}>
            <div style={{ fontWeight:700, color:'#8A8896', textTransform:'uppercase', fontSize:10, letterSpacing:'0.04em', marginBottom:2 }}>{formatPayloadKey(k)}</div>
            {inline !== null ? (
              <div style={{ color:'#1B1B3A', lineHeight:1.5, wordBreak:'break-word' }}>{inline}</div>
            ) : (
              <div style={{ paddingLeft:10, borderLeft:'2px solid #EEEBE3', display:'flex', flexDirection:'column', gap:3 }}>
                {Object.entries(v).map(([nk, nv]) => (
                  <div key={nk} style={{ fontSize:11.5, color:'#4A4A63' }}>
                    <b style={{ color:'#75737F' }}>{formatPayloadKey(nk)}:</b> {REDACTED_KEY_RE.test(nk) ? '[redacted]' : formatPayloadValue(nv)}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Lead Journey — the vertical checkpoint tracker ─────────────────────────
// One row per checkpoint on the ladder (backend/lead-journey.cjs), grey if
// not reached, colored + timestamped if it was. Checkpoints whose payload
// is worth showing (requirements shared, options shown, property details,
// a voice call's disposition — lead-journey.cjs's `info: true` flag) get a
// small (i) affordance. Opens on hover (Part 5's explicit ask) AND stays
// toggleable by click/tap — hover alone doesn't work on a touch screen, so
// click is kept as a first-class trigger too, not just a hover fallback.
// Part 13 — the timeline previously read as a flat list of dim/faint rows
// with no visual thread connecting them, so a completed checkpoint didn't
// look meaningfully different from a future one at a glance. Now: a solid
// filled dot with a checkmark + a solid colored connector for anything
// reached, a hollow outline dot + a light dashed connector for anything
// still ahead — the same "done vs. not done yet" language a shipping
// tracker uses, applied to real backend-reported checkpoints only (never
// a step marked complete unless step.reached is actually true).
function JourneyStep({ step, channelColor, isLast }) {
  const [open, setOpen] = useState(false)
  const closeTimer = React.useRef(null)
  const showInfo = step.info && step.reached
  const openNow = () => { clearTimeout(closeTimer.current); setOpen(true) }
  const closeSoon = () => { closeTimer.current = setTimeout(() => setOpen(false), 150) }
  return (
    <div style={{ display:'flex', gap:10, alignItems:'flex-start' }}>
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center', paddingTop:2, alignSelf:'stretch' }}>
        {step.reached ? (
          <span style={{ width:18, height:18, borderRadius:'50%', background:channelColor, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <Check size={11} strokeWidth={3} color="#fff" />
          </span>
        ) : (
          <span style={{ width:18, height:18, borderRadius:'50%', background:'#fff', border:'2px solid #D3D1C7', flexShrink:0 }} />
        )}
        {!isLast && (
          <span style={{ flex:1, width:2, minHeight:18, marginTop:2, background: step.reached ? channelColor : 'repeating-linear-gradient(to bottom, #D3D1C7 0, #D3D1C7 3px, transparent 3px, transparent 6px)' }} />
        )}
      </div>
      <div style={{ flex:1, paddingBottom:18, minWidth:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
          <span style={{ fontSize:13, fontWeight: step.reached ? 700 : 500, color: step.reached ? '#1B1B3A' : '#B0AEB8' }}>{step.label}</span>
          {showInfo && (
            <div style={{ position:'relative', display:'flex' }} onMouseEnter={openNow} onMouseLeave={closeSoon}>
              <button onClick={() => setOpen(o => !o)} title="Show details" aria-label={`Show details for ${step.label}`}
                style={{ background:'none', border:'none', cursor:'pointer', padding:0, display:'flex', color: open ? '#0E0E52' : '#8A8896' }}>
                <Info size={13} strokeWidth={2.2} />
              </button>
              {open && (
                <div onMouseEnter={openNow} onMouseLeave={closeSoon}
                  style={{ position:'absolute', top:'130%', left:0, zIndex:50, background:'#fff', border:'1px solid #E9E7E0', borderRadius:9, boxShadow:'0 10px 28px rgba(16,24,40,0.14)', padding:'10px 12px', minWidth:220, maxWidth:300 }}>
                  <div style={{ fontSize:10.5, fontWeight:700, color:'#8A8896', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:8 }}>Payload</div>
                  <PayloadPopover payload={step.payload} />
                </div>
              )}
            </div>
          )}
          {step.reached && step.occurredAt && (
            <span style={{ fontSize:11, color:'#8A8896' }}>{new Date(step.occurredAt).toLocaleString('en-IN', { dateStyle:'medium', timeStyle:'short' })}</span>
          )}
        </div>
      </div>
    </div>
  )
}

// Fetches GET /api/leads/:id/journey (lead-events.cjs, joining
// lead-journey.cjs's ladder against this lead's real lead_events rows) and
// renders it as two tabs — WhatsApp and Voice each have their own ladder
// shape (see lead-journey.cjs's module docstring for why they're not
// unified into one).
function LeadJourneyTracker({ leadId }) {
  const [journey, setJourney] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('whatsapp')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`${API}/api/leads/${leadId}/journey`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setJourney(d) })
      .catch(() => { if (!cancelled) setJourney(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [leadId])

  if (loading) return <div style={{ fontSize:13, color:'#8A8896' }}>Loading…</div>
  if (!journey) return <div style={{ fontSize:13, color:'#8A8896' }}>Journey tracker isn't connected yet.</div>

  const steps = journey[tab] || []
  const channelColor = tab === 'whatsapp' ? '#25D366' : '#0E0E52'
  const reachedCount = steps.filter(s => s.reached).length

  return (
    <div>
      <div style={{ display:'flex', gap:6, marginBottom:16 }}>
        {['whatsapp', 'voice'].map(k => (
          <button key={k} onClick={() => setTab(k)}
            style={{ padding:'6px 14px', borderRadius:20, fontSize:12.5, fontWeight:700, cursor:'pointer', border:'1px solid',
                     borderColor: tab === k ? '#0E0E52' : '#E9E7E0', background: tab === k ? '#0E0E52' : '#fff', color: tab === k ? '#fff' : '#4A4A63' }}>
            {k === 'whatsapp' ? 'WhatsApp' : 'Voice'}
          </button>
        ))}
        <span style={{ fontSize:12, color:'#8A8896', alignSelf:'center', marginLeft:4 }}>{reachedCount} of {steps.length} reached</span>
      </div>
      {steps.length === 0 ? (
        <div style={{ fontSize:13, color:'#8A8896' }}>No checkpoints defined for this channel.</div>
      ) : (
        <div>{steps.map((step, i) => <JourneyStep key={step.key} step={step} channelColor={channelColor} isLast={i === steps.length - 1} />)}</div>
      )}
    </div>
  )
}

// ProtectedField/Field/EditableField — see src/components/ui/ProtectedField.jsx
// and src/components/ui/EditableField.jsx (imported above): the same lock-
// icon (protected) / pencil-icon (editable) pair Project Intelligence and
// every other screen with field-level metadata now uses, with a native
// tooltip on the lock ("Protected field — captured at intake") instead of
// no affordance at all.

// Click-to-open status dropdown, backed by the exact same PATCH /api/leads/:id
// + EDITABLE_LEAD_FIELDS path as every other EditableField (status was just
// added to that allowlist server-side) — so it gets the same audit trail
// (lead_edits) and the same "not required to touch crm_status/CRM push"
// guarantee for free, with no separate status-update mechanism.
function StatusEditor({ lead, onSaved }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const ref = React.useRef(null)
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const color = STATUS_COLOR[lead.status] || '#8B8BD6'

  const choose = async (next) => {
    if (next === lead.status) { setOpen(false); return }
    setSaving(true); setErr(null)
    try {
      const res = await fetch(`${API}/api/leads/${lead.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      onSaved(j.lead)
      setOpen(false)
    } catch (e) { setErr(e.message) }
    finally { setSaving(false) }
  }

  return (
    <div ref={ref} style={{ position:'relative' }}>
      <button onClick={() => setOpen(o => !o)} disabled={saving} title="Change status"
        style={{ display:'flex', alignItems:'center', gap:4, background:'none', border:'none', padding:0, cursor: saving ? 'wait' : 'pointer' }}>
        <StatusPill label={lead.status || 'New'} color={color} />
        <ChevronDown size={13} strokeWidth={2.5} color={color} style={{ opacity:0.75 }} />
      </button>
      {open && (
        <div style={{ position:'absolute', top:'120%', left:0, zIndex:40, background:'#fff', border:'1px solid #E9E7E0', borderRadius:9, boxShadow:'0 10px 28px rgba(16,24,40,0.14)', padding:5, minWidth:200 }}>
          {STATUS_OPTIONS.map(opt => {
            const active = opt === lead.status
            return (
              <div key={opt} onClick={() => choose(opt)}
                style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 10px', borderRadius:6, fontSize:12.5, fontWeight:600, cursor:'pointer', color: active ? STATUS_COLOR[opt] : '#4A4A63', background: active ? `${STATUS_COLOR[opt]}12` : 'transparent' }}>
                <span style={{ width:7, height:7, borderRadius:'50%', background: STATUS_COLOR[opt], flexShrink:0 }} />
                {opt}
              </div>
            )
          })}
        </div>
      )}
      {err && <div style={{ position:'absolute', top:'100%', left:0, marginTop:4, fontSize:11, color:'#D64545', whiteSpace:'nowrap' }}>{err}</div>}
    </div>
  )
}

// Small header-row toggle — kept separate from the composer panel below so
// the panel can render full-width in the section body instead of being
// squeezed into the header's right-aligned flex slot.
function FollowUpButton({ open, onClick }) {
  return (
    <button onClick={onClick}
      style={{ display:'flex', alignItems:'center', gap:6, background: open ? '#0E0E52' : '#fff', color: open ? '#fff' : '#0E0E52', border:'1px solid', borderColor: open ? '#0E0E52' : '#E9E7E0', borderRadius:7, padding:'6px 13px', fontSize:12, fontWeight:700, cursor:'pointer', fontFamily:"'Plus Jakarta Sans',sans-serif" }}>
      <MessageSquarePlus size={13} strokeWidth={2.2} /> Follow-up
    </button>
  )
}

// Follow-up composer panel — posts to /api/leads/:id/follow-up (logs into
// the same lead_edits audit table the Activity feed already reads,
// field='follow_up' — no new/duplicate data structure). onSaved refreshes
// the Activity feed so the new note appears immediately.
function FollowUpComposer({ leadId, onSaved, onClose }) {
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  const save = async () => {
    const trimmed = note.trim()
    if (!trimmed || saving) return
    setSaving(true); setErr(null)
    try {
      const res = await fetch(`${API}/api/leads/${leadId}/follow-up`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: trimmed }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      onSaved()
      onClose()
    } catch (e) { setErr(e.message) }
    finally { setSaving(false) }
  }

  return (
    <div style={{ background:'#F9F8F6', border:'1px solid #E9E7E0', borderRadius:9, padding:12, marginBottom:16 }}>
      <textarea autoFocus value={note} disabled={saving} onChange={e => setNote(e.target.value)}
        placeholder="Add a follow-up note… e.g. “Call tomorrow regarding 2 BHK availability.”"
        rows={3}
        style={{ width:'100%', boxSizing:'border-box', border:'1px solid #E9E7E0', borderRadius:7, padding:'9px 11px', fontSize:13, fontFamily:"'Plus Jakarta Sans',sans-serif", outline:'none', resize:'vertical' }} />
      {err && <div style={{ fontSize:11.5, color:'#D64545', marginTop:6 }}>{err}</div>}
      <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:9 }}>
        <button onClick={onClose} disabled={saving}
          style={{ padding:'6px 14px', background:'#fff', color:'#75737F', border:'1px solid #E9E7E0', borderRadius:7, fontSize:12, fontWeight:600, cursor:'pointer' }}>
          Cancel
        </button>
        <button onClick={save} disabled={saving || !note.trim()}
          style={{ padding:'6px 16px', background: note.trim() ? '#0E0E52' : '#ccc', color:'#fff', border:'none', borderRadius:7, fontSize:12, fontWeight:700, cursor: note.trim() && !saving ? 'pointer' : 'not-allowed' }}>
          {saving ? 'Saving…' : 'Save Follow-up'}
        </button>
      </div>
    </div>
  )
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase()
}

// ── Meta Ad Leads, sourced from IndiHomes' OWN CRM (backend/
// indihomes-crm-leads-client.cjs's GET /api/leads/meta-crm) — genuinely
// separate from the existing unified inbox table above, which only ever
// shows leads already ingested into THIS app's own local database (via
// Facebook Graph API direct pull, Housing.com, website intake, or manual
// add). A CRM-sourced lead here is NOT a row in our local database — it
// can't be PATCHed via /api/leads/:id, has no local id/edit-history/AI-
// activity tracking, and its exact field shape (name/phone/project keys)
// isn't documented anywhere this session had access to. Rendered as its
// own small, clearly-labeled, read-only section rather than merged into
// the editable table above, which would either break (wrong field names)
// or silently offer edit/detail actions that don't actually work for a
// record that lives in a different system entirely.
//
// Field access is deliberately defensive (tries a few plausible key names
// per value) since the real CRM response shape hasn't been confirmed
// against live data yet — same "diagnose against real data, don't guess
// silently" discipline already used for the IndiHomes price/carpet-area
// fields elsewhere in this app. Logs one raw record's keys to the console
// on first load if none of the guessed field names produced a name/phone,
// so the real shape can be confirmed and this hardened afterward.
function pick(obj, keys) {
  for (const k of keys) if (obj?.[k] != null && obj[k] !== '') return obj[k]
  return null
}
// Meta's own field_data shape (confirmed real — the actual SDK call is
// `new Lead(leadId).get(["field_data", "created_time"])`):
// [{ name: 'full_name', values: ['John Doe'] }, { name: 'phone_number', values: ['+91...'] }, ...].
// Used as a fallback when the flat name/phone fields above aren't present
// on the stored lead — IndiHomes' backend may or may not have flattened
// these into top-level fields when it saved the lead.
function fromFieldData(raw, ...nameCandidates) {
  const fd = raw?.field_data || raw?.fieldData
  if (!Array.isArray(fd)) return null
  for (const cand of nameCandidates) {
    const entry = fd.find(f => String(f?.name || '').toLowerCase() === cand)
    if (entry?.values?.[0]) return entry.values[0]
  }
  return null
}
let _loggedMetaCrmShapeOnce = false
function metaCrmLeadFields(raw) {
  const name = pick(raw, ['name', 'lead_name', 'full_name', 'customer_name']) || fromFieldData(raw, 'full_name', 'name')
  const phone = pick(raw, ['phone', 'mobile', 'contact_number', 'number']) || fromFieldData(raw, 'phone_number', 'phone')
  const project = pick(raw, ['project', 'project_name', 'projectName'])
  const source = pick(raw, ['lead_source', 'source', 'campaign', 'adSrc']) || pick(raw, ['ad_name', 'adName'])
  const capturedAt = pick(raw, ['created_at', 'createdAt', 'captured_at', 'date', 'created_time'])
  if (!name && !phone && !_loggedMetaCrmShapeOnce) {
    _loggedMetaCrmShapeOnce = true
    console.warn('[meta-crm] none of the guessed field names matched — real CRM lead shape:', JSON.stringify(raw).slice(0, 500))
  }
  return { name, phone, project, source, capturedAt }
}

function MetaCrmLeadsSection() {
  const [open, setOpen] = useState(false)
  const [leads, setLeads] = useState(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)

  const load = () => {
    setLoading(true); setErr(null)
    fetch(`${API}/api/leads/meta-crm`).then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setLeads(d.leads || []) })
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false))
  }
  const toggle = () => { setOpen(o => !o); if (!open && leads === null) load() }

  return (
    <div style={{ background:'#fff', border:'1px solid #E9E7E0', borderRadius:12, marginBottom:20, overflow:'hidden' }}>
      <div onClick={toggle} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'14px 18px', cursor:'pointer' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ fontSize:14, fontWeight:700, color:'#1B1B3A' }}>Meta Ad Leads</span>
          <span style={{ fontSize:11, color:'#8A8896' }}>From IndiHomes CRM — read-only</span>
          {leads !== null && <span style={{ fontSize:11, fontWeight:700, color:'#0E5FBF', background:'#EEF6FF', padding:'2px 8px', borderRadius:20 }}>{leads.length}</span>}
        </div>
        <ChevronDown size={16} strokeWidth={2.4} color="#75737F" style={{ transform: open ? 'rotate(180deg)' : 'none', transition:'transform 0.15s' }} />
      </div>
      {open && (
        <div style={{ borderTop:'1px solid #E9E7E0', padding:'12px 18px 18px' }}>
          {loading && <div style={{ fontSize:13, color:'#8A8896' }}>Loading…</div>}
          {err && <div style={{ fontSize:12.5, color:'#D64545' }}>Couldn't load Meta Ad leads from the CRM right now — try again shortly.</div>}
          {leads && leads.length === 0 && !err && <div style={{ fontSize:13, color:'#8A8896' }}>No Meta Ad leads found in the CRM.</div>}
          {leads && leads.length > 0 && (
            <div style={{ display:'flex', flexDirection:'column', gap:6, maxHeight:360, overflowY:'auto' }}>
              {leads.map((raw, i) => {
                const f = metaCrmLeadFields(raw)
                return (
                  <div key={i} style={{ display:'flex', alignItems:'center', gap:14, padding:'9px 12px', background:'#F9F8F6', border:'1px solid #F0EEE8', borderRadius:8 }}>
                    <div style={{ width:34, height:34, borderRadius:'50%', background:'#0E5FBF', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:800, flexShrink:0 }}>
                      {initials(f.name)}
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:13, fontWeight:700, color:'#1B1B3A' }}>{f.name || <EmptyValue />}</div>
                      <div style={{ fontSize:11.5, color:'#75737F' }}>
                        {f.phone || <EmptyValue />}{f.project ? ` · ${f.project}` : ''}
                      </div>
                    </div>
                    {f.capturedAt && <div style={{ fontSize:11, color:'#8A8896', whiteSpace:'nowrap' }}>{timeAgo(new Date(f.capturedAt).getTime())}</div>}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Lead detail view — rendered in-flow within LeadCapture (not a fixed
// full-viewport overlay), so the app's persistent Sidebar + TopBar (search
// box, bell, avatar, theme toggle, breadcrumb) stay exactly as every other
// screen shows them; LeadCapture appends the lead's name to the breadcrumb
// via onBreadcrumbExtra (App.jsx -> TopBar). Locked: name, phone,
// first-captured timestamp, and crm_status (CRM-push-driven — see
// meta-capi.cjs's header comment for why this codebase's "CRM status" means
// push-delivery outcome, not a lead-qualification signal; there is no such
// signal anywhere in this data today). Everything else editable inline via
// EditableField, every change audited (lead_edits, append-only, same
// pattern as lead_touches) — none of that behavior changed in this pass,
// only how it's presented.
function LeadDetailView({ lead: initialLead, onClose }) {
  const [lead, setLead] = useState(initialLead)
  const [touches, setTouches] = useState([])
  const [edits, setEdits] = useState([])
  const [loadingActivity, setLoadingActivity] = useState(true)
  const [followUpOpen, setFollowUpOpen] = useState(false)

  const refreshEdits = useCallback(() => {
    fetch(`${API}/api/leads/${initialLead.id}/edits`).then(r => r.json()).then(d => setEdits(d.edits || [])).catch(() => {})
  }, [initialLead.id])

  useEffect(() => {
    let cancelled = false
    setLoadingActivity(true)
    fetch(`${API}/api/leads/${initialLead.id}/touches`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setTouches(d.touches || []) })
      .catch(() => { if (!cancelled) setTouches([]) })
      .finally(() => { if (!cancelled) setLoadingActivity(false) })
    refreshEdits()
    return () => { cancelled = true }
  }, [initialLead.id, refreshEdits])

  const onFieldSaved = (updatedLead) => { setLead(updatedLead); refreshEdits() }
  // Bound onSave callback per field for the shared EditableField component
  // (src/components/ui/EditableField.jsx) — that component knows nothing
  // about the leads API, only "call this async function with the new
  // value"; this is where the actual PATCH + audit-refresh happens.
  const saveField = (field) => async (draft) => {
    const res = await fetch(`${API}/api/leads/${lead.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: draft }),
    })
    const j = await res.json()
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
    onFieldSaved(j.lead)
  }

  return (
    <div style={{ maxWidth:960 }}>
      <button onClick={onClose} style={{ background:'#F6F5F1', border:'none', borderRadius:8, padding:'7px 14px', fontSize:12.5, fontWeight:700, color:'#0E0E52', cursor:'pointer', marginBottom:18 }}>← Back to leads</button>

      {/* Header — avatar + name/status get real visual weight, matching the
          hero-card treatment ProjectIntelligence uses for its lead subject. */}
      <div style={{ display:'flex', alignItems:'center', gap:16, marginBottom:22 }}>
        <div style={{ width:52, height:52, borderRadius:'50%', background:'#0E0E52', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, fontWeight:800, flexShrink:0 }}>
          {initials(lead.name)}
        </div>
        <div>
          <div style={{ fontSize:26, fontWeight:800, color:'#0E0E52', lineHeight:1.15 }}>{lead.name || 'Unnamed lead'}</div>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:6 }}>
            <StatusEditor lead={lead} onSaved={onFieldSaved} />
            <span style={{ fontSize:12.5, color:'#75737F' }}>{SOURCE_LABEL[lead.primary_source] || lead.primary_source}</span>
            <span style={{ fontSize:12.5, color:'#8A8896' }}>· {timeAgo(lead.created_at)}</span>
          </div>
        </div>
      </div>

      <SectionCard title="Lead Overview" accent="#0E0E52" style={{ marginBottom:20 }}>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:20 }}>
          <ProtectedField label="Name" value={lead.name} />
          <ProtectedField label="Phone" value={lead.phone ? (lead.phone.startsWith('+') ? lead.phone : `+91 ${lead.phone}`) : null} />
          <Field label="Source" value={SOURCE_LABEL[lead.primary_source] || lead.primary_source} />
          <ProtectedField label="Created" value={new Date(lead.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} />
          <EditableFieldShared label="Email" value={lead.email} onSave={saveField('email')} />
          {/* CRM status — locked, CRM-push-driven (see meta-capi.cjs's header
              comment: this app's only real "CRM status" is push-delivery
              success/failed to IndiHomes' own createLead API, not a lead-
              qualification signal — shown honestly as such, never overridden). */}
          <ProtectedField label="CRM Status" value={(
            <span style={{ display:'flex', alignItems:'center', gap:6 }}>
              <CrmBadge status={lead.crm_status} error={lead.crm_error} />
              {lead.crm_synced_at && <span style={{ fontSize:11, color:colors.muted }}>{timeAgo(lead.crm_synced_at)}</span>}
            </span>
          )} />
        </div>
      </SectionCard>

      <SectionCard title="Requirements" accent="#2E9E4F" style={{ marginBottom:20 }}>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:20, marginBottom:18 }}>
          <EditableFieldShared label="Project" value={lead.project} onSave={saveField('project')} />
          <EditableFieldShared label="Configuration" value={lead.configuration} onSave={saveField('configuration')} />
          <EditableFieldShared label="Budget" value={lead.budget} onSave={saveField('budget')} />
          <EditableFieldShared label="Location" value={lead.location} onSave={saveField('location')} />
          <EditableFieldShared label="Possession date" value={lead.possession_date} onSave={saveField('possession_date')} />
          <EditableFieldShared label="Amenities" value={lead.amenities} onSave={saveField('amenities')} />
        </div>
        <EditableFieldShared label="Notes" value={lead.notes} onSave={saveField('notes')} />
      </SectionCard>

      {/* AI Activity — WhatsApp bot / AI voice agent mascots with a tick,
          plus the horizontally-scrollable status/sub-status strip that
          drives the Meta CAPI qualified/disqualified dispatch. New in this
          pass — see backend/LEAD_EVENTS_INTEGRATION.md for the full
          pipeline this reads from. */}
      <SectionCard title="AI Activity" accent="#0E5FBF" style={{ marginBottom:20 }}>
        <AiActivityCard lead={lead} onQualificationSaved={onFieldSaved} />
      </SectionCard>

      <SectionCard title="Conversations" accent="#F7941D" style={{ marginBottom:20 }}>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <ConversationCard title="WhatsApp Bot" icon={MessageCircle} summary={lead.whatsapp_summary} summaryAt={lead.whatsapp_summary_at}
            leadId={lead.id} endpoint={`/api/leads/${lead.id}/whatsapp-conversation`} kind="whatsapp" />
          <ConversationCard title="AI Calling Agent" icon={Phone} summary={lead.call_summary} summaryAt={lead.call_summary_at}
            leadId={lead.id} endpoint={`/api/leads/${lead.id}/call-transcript`} kind="call" />
        </div>
      </SectionCard>

      {/* Part 12 — Activity (the Lead Journey WATI/voice checkpoint tracker,
          plus the edit-history feed) is now the LAST major section on the
          page, per the required page structure: header -> info ->
          requirements -> conversations -> WhatsApp/voice -> other lead
          intelligence -> Activity -> END. Previously sandwiched between
          Requirements and Conversations, which read as a large card
          floating between unrelated sections. */}
      <SectionCard title="Lead Journey" accent="#6B4FBB" style={{ marginBottom:20 }}>
        <LeadJourneyTracker leadId={lead.id} />
      </SectionCard>

      <SectionCard title="Activity" accent="#6B4FBB" style={{ marginBottom:20 }} action={<FollowUpButton open={followUpOpen} onClick={() => setFollowUpOpen(o => !o)} />}>
        {followUpOpen && (
          <FollowUpComposer leadId={lead.id} onSaved={refreshEdits} onClose={() => setFollowUpOpen(false)} />
        )}
        {loadingActivity ? <div style={{ fontSize:13, color:'#8A8896' }}>Loading…</div> : <ActivityFeed touches={touches} edits={edits} />}
      </SectionCard>
    </div>
  )
}

// Connection/health status strip for a lead source — replaces the previous
// "only find out on click" pattern with an always-visible indicator.
//
// Detail text deliberately never surfaces raw technical content (a Graph
// API error string like "Meta Graph 400: Error validating access token:
// Session has expired on Monday, 17-Aug-26 04:00:00 PDT...", an endpoint
// path like "POST /api/leads/intake/website", or any other implementation
// detail) — per the explicit instruction that no source/debug metadata
// belongs in end-user UI. The underlying status object (configured/
// lastSuccess/lastFailure/description) is untouched server-side for
// anyone who needs the real detail (server logs, an admin API) — only
// this component's rendering was simplified.
function SourceStatus({ label, status }) {
  if (!status) return null
  const dot = !status.configured ? '#D64545' : status.lastFailure && (!status.lastSuccess || status.lastFailure.ran_at > status.lastSuccess.ran_at) ? '#F7941D' : status.lastSuccess ? '#2E9E4F' : '#8A8896'
  const detail = !status.configured
    ? 'Not connected'
    : status.lastFailure && (!status.lastSuccess || status.lastFailure.ran_at > status.lastSuccess.ran_at)
    ? 'Sync issue — contact your administrator'
    : status.lastSuccess
    ? `Last synced ${timeAgo(status.lastSuccess.ran_at)} · ${status.lastSuccess.created ?? 0} new`
    : 'Not synced yet'
  return (
    <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 14px', background:'#fff', border:'1px solid #E9E7E0', borderRadius:10, fontSize:12 }}>
      <span style={{ width:8, height:8, borderRadius:'50%', background:dot, flexShrink:0 }} />
      <span style={{ fontWeight:700, color:'#1B1B3A' }}>{label}</span>
      <span style={{ color:'#8A8896' }}>{detail}</span>
    </div>
  )
}

// Compact per-row AI Activity indicator for the leads table (Part 1) — the
// same WhatsApp/voice mascot language as the Lead Detail AI Activity card
// (MascotTick above), just small enough for a table cell. Backed by
// ai_whatsapp_active/ai_whatsapp_failed/ai_voice_active/ai_voice_failed,
// three lightweight EXISTS-subquery flags db.cjs's listLeads() now
// projects straight off lead_events (see db.cjs's listLeadsStmt comment) —
// deliberately NOT a per-row fetch of the full getAiActivity() detail
// (that stays a lead-detail-view-only query), so this table never fires
// one extra request per lead. SQLite EXISTS(...) comes back as 0/1, not a
// real boolean, hence the Number(...) coercion below.
function MiniMascotDot({ Icon, bg, active, failed, label }) {
  const state = failed ? 'failed' : active ? 'ok' : 'none'
  const badgeColor = state === 'ok' ? '#2E9E4F' : state === 'failed' ? '#D64545' : '#C8C6D0'
  return (
    <span title={`${label}: ${state === 'ok' ? 'reached' : state === 'failed' ? 'attempted, failed' : 'no activity yet'}`}
      style={{ position:'relative', width:20, height:20, display:'inline-flex', flexShrink:0 }}>
      <span style={{ width:20, height:20, borderRadius:'50%', background: state === 'none' ? '#E9E7E0' : bg, display:'flex', alignItems:'center', justifyContent:'center' }}>
        <Icon size={11} color={state === 'none' ? '#B8B6C0' : '#fff'} strokeWidth={2.2} />
      </span>
      <span style={{ position:'absolute', bottom:-2, right:-2, width:9, height:9, borderRadius:'50%', background:badgeColor, border:'1.5px solid #fff' }} />
    </span>
  )
}
function AiActivityMini({ lead }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
      <MiniMascotDot Icon={MessageCircle} bg="#25D366" active={!!Number(lead.ai_whatsapp_active)} failed={!!Number(lead.ai_whatsapp_failed)} label="WhatsApp bot" />
      <MiniMascotDot Icon={Phone} bg="#0E0E52" active={!!Number(lead.ai_voice_active)} failed={!!Number(lead.ai_voice_failed)} label="AI voice agent" />
    </div>
  )
}

// Per-lead official-CRM push status. Distinct from the sync-health strip
// above (that's about leads coming IN from Meta/Housing.com/website); this
// is about whether THIS lead has gone OUT to IndiHomes' own createLead API.
function CrmBadge({ status, error }) {
  if (status === 'success') return <span title="Pushed to the official IndiHomes CRM"><StatusPill label="✓ Synced" color="#156B35" size="sm" /></span>
  if (status === 'failed') return <span title={error || 'CRM push failed'}><StatusPill label="✗ Failed" color="#B02020" size="sm" /></span>
  return <EmptyValue />
}

// Real leads from the intake pipeline (/api/leads — Housing.com hourly pull,
// Meta webhook, universal POST intake), replacing the static demo rows this
// screen shipped with. Lead scoring is a later module (timeline row 9), so
// there is no score column yet rather than a fake one.
export default function LeadCapture({ onBreadcrumbExtra }) {
  const [leads, setLeads] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [sourceFilter, setSourceFilter] = useState('All')
  const [syncingSource, setSyncingSource] = useState(null) // 'housing' | 'meta' | null
  const [syncMsg, setSyncMsg] = useState(null)
  const [syncStatus, setSyncStatus] = useState(null) // { housing, meta, website }
  const [addLeadOpen, setAddLeadOpen] = useState(false)
  const [selectedLead, setSelectedLead] = useState(null)

  const fetchLeads = useCallback(() => {
    fetch(`${API}/api/leads?limit=5000`)
      .then(r => r.json())
      .then(d => { setLeads(d.leads || []); setError(null) })
      .catch(() => setError('Cannot reach the data server (port 3001). Run: npm run server'))
      .finally(() => setLoading(false))
  }, [])

  const fetchSyncStatus = useCallback(() => {
    fetch(`${API}/api/leads/sync-status`).then(r => r.json()).then(setSyncStatus).catch(() => {})
  }, [])

  useEffect(() => {
    fetchLeads()
    fetchSyncStatus()
    const id = setInterval(fetchLeads, 30000)
    const statusId = setInterval(fetchSyncStatus, 30000)
    return () => { clearInterval(id); clearInterval(statusId) }
  }, [fetchLeads, fetchSyncStatus])

  const runSync = async (source, label, endpoint, reqBody = {}) => {
    setSyncingSource(source); setSyncMsg(null)
    try {
      const res = await fetch(`${API}${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      const forms = j.formsChecked != null ? ` across ${j.formsChecked} forms` : ''
      setSyncMsg(`${label}: ${j.fetched} fetched · ${j.created} new · ${j.duplicates} already known${forms}`)
      fetchLeads()
    } catch (e) { setSyncMsg(`${label} sync failed: ${e.message}`) }
    finally { setSyncingSource(null); fetchSyncStatus() }
  }
  const syncHousing = () => runSync('housing', 'Housing.com', '/api/leads/sync-housing')
  const syncMeta = () => runSync('meta', 'Meta', '/api/leads/sync-meta', { sinceDate: '2020-01-01' })

  const addLead = async (fields) => {
    const res = await fetch(`${API}/api/leads`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'manual', leadData: fields }),
    })
    const j = await res.json()
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
    fetchLeads()
  }

  const openLead = (l) => { setSelectedLead(l); onBreadcrumbExtra?.(l.name || 'Lead') }
  const closeLead = () => { setSelectedLead(null); onBreadcrumbExtra?.(null); fetchLeads() }

  // Source chips computed from the actual data, not hardcoded totals.
  const bySource = {}
  for (const l of leads) {
    const label = SOURCE_LABEL[l.primary_source] || l.primary_source
    bySource[label] = (bySource[label] || 0) + 1
  }
  const sources = ['All', ...Object.keys(bySource).sort()]
  const filtered = sourceFilter === 'All' ? leads
    : leads.filter(l => (SOURCE_LABEL[l.primary_source] || l.primary_source) === sourceFilter)

  // Detail view replaces the list in-place (still the app's own content
  // pane, not a fixed full-viewport overlay) so Sidebar + TopBar stay
  // visible exactly like every other screen — see LeadDetailView's header
  // comment.
  if (selectedLead) {
    return (
      <div style={{ padding:'28px 32px' }}>
        <LeadDetailView lead={selectedLead} onClose={closeLead} />
      </div>
    )
  }

  return (
    <div style={{ padding:'28px 32px', maxWidth:1280 }}>
      {addLeadOpen && <AddLeadModal onClose={() => setAddLeadOpen(false)} onSubmit={addLead} />}
      <ModuleHeader module="MODULE 07" title="Unified Lead Inbox"
        subtitle={loading ? 'Loading…' : `${Object.keys(bySource).length} source${Object.keys(bySource).length === 1 ? '' : 's'} normalised · ${leads.length} leads captured`}
        rightContent={
          <button onClick={() => setAddLeadOpen(true)} style={{ padding:'9px 18px', background:'#FECF55', color:'#0E0E52', border:'none', borderRadius:8, fontSize:13, fontWeight:700, cursor:'pointer' }}>＋ Add Lead</button>
        } />

      {error && (
        <div style={{ background:'#FEE8E8', border:'1px solid #D6454540', borderRadius:8, padding:'12px 14px', color:'#D64545', fontSize:13, marginBottom:16 }}>{error}</div>
      )}

      {/* Connection/health status per source — always visible, not just on click */}
      <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap' }}>
        <SourceStatus label="Housing.com" status={syncStatus?.housing} />
        <SourceStatus label="Meta" status={syncStatus?.meta} />
        <SourceStatus label="IndiHomes Website" status={syncStatus?.website} />
      </div>

      {/* Meta Ad Leads, sourced directly from IndiHomes' own CRM (Section 8) —
          a separate, read-only, collapsible section, not merged into the
          editable unified-inbox table below (see MetaCrmLeadsSection's own
          header comment for why). Collapsed by default; loads on first
          expand. */}
      <MetaCrmLeadsSection />

      {/* NOTE: the "IndiHomes CRM push" status field (syncStatus.crm) was
          intentionally removed from this screen per a UI-only cleanup pass —
          the backend (INDIHOMES_LEAD_PUSH_ENABLED, indihomes-leads-client.cjs,
          crm_status/crm_push_log tracking, /api/leads/sync-status's `crm` key,
          retry logic) is fully intact and unchanged; only this rendering was
          removed. Per-lead CRM sync state is still visible via each lead's
          CrmBadge in the table/detail view below. */}

      {/* Source chips — live counts */}
      <div style={{ display:'flex', gap:10, marginBottom:20, flexWrap:'wrap', alignItems:'center' }}>
        {Object.entries(bySource).map(([s, n]) => (
          <div key={s} style={{ padding:'6px 14px', background:'#fff', border:'1px solid #E9E7E0', borderRadius:20, fontSize:12, fontWeight:600, color:'#1B1B3A' }}>{s}: {n}</div>
        ))}
        <div style={{ marginLeft:'auto', display:'flex', gap:8 }}>
          <button onClick={syncMeta} disabled={!!syncingSource || (syncStatus && !syncStatus.meta?.configured)}
            title={syncStatus && !syncStatus.meta?.configured ? `Missing: ${(syncStatus.meta.missingEnv || []).join(', ')}` : ''}
            style={{ padding:'7px 16px', background: syncingSource || (syncStatus && !syncStatus.meta?.configured) ? '#ccc' : '#0E0E52', color:'#fff', border:'none', borderRadius:8, fontSize:12.5, fontWeight:600, cursor: syncingSource || (syncStatus && !syncStatus.meta?.configured) ? 'not-allowed' : 'pointer' }}>
            {syncingSource === 'meta' ? '⟳ Syncing…' : '⟳ Sync Meta now'}
          </button>
          <button onClick={syncHousing} disabled={!!syncingSource || (syncStatus && !syncStatus.housing?.configured)}
            title={syncStatus && !syncStatus.housing?.configured ? `Missing: ${(syncStatus.housing.missingEnv || []).join(', ')}` : ''}
            style={{ padding:'7px 16px', background: syncingSource || (syncStatus && !syncStatus.housing?.configured) ? '#ccc' : '#0E0E52', color:'#fff', border:'none', borderRadius:8, fontSize:12.5, fontWeight:600, cursor: syncingSource || (syncStatus && !syncStatus.housing?.configured) ? 'not-allowed' : 'pointer' }}>
            {syncingSource === 'housing' ? '⟳ Syncing…' : '⟳ Sync Housing.com now'}
          </button>
        </div>
      </div>
      {syncMsg && <div style={{ fontSize:12.5, color:'#2E9E4F', marginBottom:12, fontWeight:600 }}>{syncMsg}</div>}

      {/* Source filter */}
      <div style={{ display:'flex', gap:8, marginBottom:16, flexWrap:'wrap' }}>
        {sources.map(f => (
          <button key={f} onClick={() => setSourceFilter(f)} style={{ padding:'6px 16px', border:'1px solid', borderColor: sourceFilter===f?'#0E0E52':'#E9E7E0', background: sourceFilter===f?'#0E0E52':'#fff', color: sourceFilter===f?'#fff':'#1B1B3A', borderRadius:20, fontSize:13, fontWeight:500, cursor:'pointer' }}>{f}</button>
        ))}
        <div style={{ marginLeft:'auto', fontSize:13, color:'#75737F', display:'flex', alignItems:'center' }}>{filtered.length} leads</div>
      </div>

      {/* Table — condensed to 7 columns (was 10): Lead folds in phone,
          Requirement folds in configuration/budget/location as one scannable
          line, matching how a real CRM list view groups secondary fields
          under the primary one instead of giving each its own column. */}
      <div style={{ background:'#fff', border:'1px solid #E9E7E0', borderRadius:12, overflow:'hidden' }}>
        <div style={{ overflowX:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse', minWidth:820 }}>
          <thead>
            <tr style={{ background:'#F6F5F1' }}>
              {['Lead','Project','Requirement','Source','Captured','Status','AI Activity'].map(h => (
                <th key={h} style={{ padding:'9px 14px', textAlign:'left', fontSize:10.5, color:'#8A8896', fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', fontFamily:"'IBM Plex Mono',monospace", borderBottom:'1px solid #E9E7E0' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={7} style={{ padding:'32px 14px', textAlign:'center', fontSize:13, color:'#8A8896' }}>
                No leads yet — they'll appear here as Housing.com syncs (hourly), Meta leads arrive, or you add one directly.
              </td></tr>
            )}
            {filtered.map((l, i) => (
              <tr key={l.id} onClick={() => openLead(l)}
                style={{ borderTop: i === 0 ? 'none' : '1px solid #F0EEE8', background: '#fff', cursor:'pointer', transition:'background 0.1s' }}
                onMouseEnter={e => e.currentTarget.style.background = '#F6F6FB'}
                onMouseLeave={e => e.currentTarget.style.background = '#fff'}>
                <td style={{ padding:'10px 14px' }}>
                  <div style={{ fontWeight:700, fontSize:13, color:'#1B1B3A' }}>{l.name || <EmptyValue />}</div>
                  <div style={{ fontSize:11.5, color:'#8A8896', fontFamily:"'IBM Plex Mono',monospace", marginTop:1 }}>{l.phone.startsWith('+') ? l.phone : `+91 ${l.phone}`}</div>
                </td>
                <td style={{ padding:'10px 14px', fontSize:12.5, color:'#4A4A63' }}>{l.project || <EmptyValue />}</td>
                <td style={{ padding:'10px 14px', fontSize:12, color:'#75737F' }}>
                  {[l.configuration, l.budget, l.location].filter(Boolean).join(' · ') || <EmptyValue />}
                </td>
                <td style={{ padding:'10px 14px', fontSize:12, color:'#4A4A63', whiteSpace:'nowrap' }}>
                  <span style={{ display:'inline-block', width:6, height:6, borderRadius:'50%', background: SOURCE_COLOR[l.primary_source] || '#8A8896', marginRight:6 }} />
                  {SOURCE_LABEL[l.primary_source] || l.primary_source}
                </td>
                <td style={{ padding:'10px 14px', fontSize:12, color:'#8A8896', whiteSpace:'nowrap' }}>{timeAgo(l.created_at)}</td>
                <td style={{ padding:'10px 14px' }}>
                  <StatusPill label={l.status} color={STATUS_COLOR[l.status] || '#8B8BD6'} size="sm" />
                </td>
                <td style={{ padding:'10px 14px' }}><AiActivityMini lead={l} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}

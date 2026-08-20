import React, { useEffect, useState } from 'react'
import { Pencil } from 'lucide-react'
import { colors } from './tokens.js'
import { fieldLabelStyle, fieldValueStyle } from './ProtectedField.jsx'

// Click-to-edit field. Generic over HOW the save happens — `onSave(value)`
// is an async function the caller supplies (e.g. Lead Capture's PATCH
// /api/leads/:id), so this component has no knowledge of any particular
// API and can be reused by any future screen with an inline-editable field,
// not just Lead Capture.
//
// Pencil icon = editable (the other half of problem #3's lock/pencil
// system — see ProtectedField.jsx for the read-only half). Subtle by
// default, brighter on hover, shown on empty values too so it's clear they
// CAN be filled in. Native `title` tooltip via the wrapping span.
export default function EditableField({ label, value, emptyLabel = 'Not captured', onSave }) {
  const [editing, setEditing] = useState(false)
  const [hover, setHover] = useState(false)
  const [draft, setDraft] = useState(value || '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => { setDraft(value || '') }, [value])

  const cancel = () => { setDraft(value || ''); setErr(null); setEditing(false) }
  const save = async () => {
    if (draft === (value || '')) { setEditing(false); return }
    setSaving(true); setErr(null)
    try {
      await onSave(draft)
      setEditing(false)
    } catch (e) { setErr(e.message) }
    finally { setSaving(false) }
  }

  if (!editing) {
    return (
      <div>
        <div style={fieldLabelStyle}>{label}</div>
        <div onClick={() => setEditing(true)} title="Click to edit"
          onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
          style={{ ...fieldValueStyle, color: value ? colors.navyText : colors.mutedLight, fontStyle: value ? 'normal' : 'italic', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
          {value || emptyLabel}
          <Pencil size={12} color={hover ? colors.navy : colors.mutedLight} strokeWidth={2.2} style={{ opacity: hover ? 1 : 0.6, transition: 'opacity 0.15s ease, color 0.15s ease', flexShrink: 0 }} />
        </div>
      </div>
    )
  }
  return (
    <div>
      <div style={fieldLabelStyle}>{label}</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input autoFocus value={draft} disabled={saving}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel() }}
          style={{ flex: 1, minWidth: 0, padding: '6px 9px', border: `1.5px solid ${colors.navy}`, borderRadius: 6, fontSize: 14, outline: 'none', fontFamily: 'var(--pg-font)' }} />
        <button onClick={save} disabled={saving} style={{ background: colors.navy, color: '#fff', border: 'none', borderRadius: 5, width: 26, height: 26, cursor: 'pointer', fontSize: 12 }}>✓</button>
        <button onClick={cancel} disabled={saving} style={{ background: colors.bg, color: colors.textSecondary, border: 'none', borderRadius: 5, width: 26, height: 26, cursor: 'pointer', fontSize: 12 }}>✕</button>
      </div>
      {err && <div style={{ fontSize: 11, color: colors.red, marginTop: 3 }}>{err}</div>}
    </div>
  )
}

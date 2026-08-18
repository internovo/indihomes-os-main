import React from 'react'
import { Lock } from 'lucide-react'
import { colors } from './tokens.js'

export const fieldLabelStyle = { fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }
export const fieldValueStyle = { fontSize: 14, fontWeight: 500 }

// One deliberate meaning per icon, applied everywhere field-level metadata
// is shown (problem #3): Lock = read-only/protected (this component),
// Pencil = editable (EditableField.jsx). Both take a native `title`
// tooltip via a wrapping span — an SVG `title` prop alone doesn't reliably
// tooltip cross-browser, a wrapping element's `title` attribute does.
export default function ProtectedField({ label, value, emptyLabel = 'Not captured' }) {
  return (
    <div>
      <div style={{ ...fieldLabelStyle, display: 'flex', alignItems: 'center', gap: 4 }}>
        {label}
        <span title="Protected field — captured at intake" style={{ display: 'inline-flex', cursor: 'help' }}>
          <Lock size={11} color={colors.mutedLight} strokeWidth={2.4} />
        </span>
      </div>
      <div style={{ ...fieldValueStyle, color: value ? colors.navyText : colors.mutedLight, fontStyle: value ? 'normal' : 'italic' }}>
        {value || emptyLabel}
      </div>
    </div>
  )
}

// Plain, non-editable, non-protected field — no icon at all (a field that's
// simply informational, neither locked nor editable, e.g. a derived/
// read-only value with no ownership implication).
export function Field({ label, value, emptyLabel = 'Not captured' }) {
  return (
    <div>
      <div style={fieldLabelStyle}>{label}</div>
      <div style={{ ...fieldValueStyle, color: value ? colors.navyText : colors.mutedLight, fontStyle: value ? 'normal' : 'italic' }}>
        {value || emptyLabel}
      </div>
    </div>
  )
}

import React from 'react'

// Fixed color-to-meaning mapping for every "how do we know this fact"
// badge in the app — every one of them renders through this one component
// so the same meaning is pixel-identical wherever it appears.
//
// `kind` picks the color + default label; pass `label` to override the
// text while keeping the same color/size/shape (e.g. a specific RERA
// number instead of the generic "Verified" wording).
const KIND = {
  verified:   { icon: '✓', label: 'Verified',    color: 'var(--pg-green)',         bg: 'var(--pg-tint-green)' },
  // Previously named the specific external provider directly in end-user-
  // facing UI — collapsed to a generic "Verified" label; kept as separate
  // keys (not merged into `verified`) so call sites stay self-documenting
  // about WHICH real source backs a given field, without that distinction
  // leaking into the label.
  map:        { icon: '✓', label: 'Verified',    color: 'var(--pg-green)',         bg: 'var(--pg-tint-green)' },
  places:     { icon: '✓', label: 'Verified',    color: 'var(--pg-green)',         bg: 'var(--pg-tint-green)' },
  ai:         { icon: '✦', label: 'AI-derived',  color: 'var(--pg-indigo)',        bg: 'var(--pg-tint-indigo)' },
  unverified: { icon: '⚠', label: 'Not found',   color: 'var(--pg-ink-3)',         bg: 'var(--pg-shell)' },
  // A plain "this field is missing" state — a normal, expected outcome for
  // many real listings, not a failure or a warning about anything. No
  // warning icon, deliberately more muted than `unverified`.
  none:       { icon: '–', label: 'Not available', color: 'var(--pg-ink-4)',       bg: 'var(--pg-shell)' },
  // A plainly stated fact, making no provenance claim in either direction.
  // For values where the number IS the point and any icon reads as a
  // verdict on it — a ⚠ next to a real RERA registration number tells the
  // user something is wrong with the number, which is not what was meant.
  // Where a field's provenance genuinely matters (Project Intelligence's
  // RERA & Compliance panel), keep using `verified`/`unverified`/`none`.
  fact:       { icon: '',  label: '',              color: 'var(--pg-ink-2)',       bg: 'var(--pg-shell)' },
}

export default function FieldBadge({ kind = 'unverified', label, compact = false, title }) {
  const k = KIND[kind] || KIND.unverified
  const text = label || k.label
  return (
    <span title={title || undefined} style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      background: k.bg, color: k.color, padding: compact ? '2px 6px' : '2px 7px', borderRadius: 'var(--pg-r-sm)',
      fontSize: 10, fontWeight: 700, fontFamily: 'var(--pg-font-mono)',
      letterSpacing: '0.03em', flexShrink: 0, whiteSpace: 'nowrap',
    }}>
      {k.icon ? `${k.icon} ${text}` : text}
    </span>
  )
}

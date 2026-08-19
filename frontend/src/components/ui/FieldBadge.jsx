import React from 'react'

// Fixed color-to-meaning mapping for every "how do we know this fact"
// badge in the app (problem #8) — Project Intelligence, Project Selection,
// and Lead Capture previously each had their own slightly-different green/
// violet/grey badge (different shade, size, or padding). Every one of them
// now renders through this one component so the same meaning is
// pixel-identical wherever it appears.
//
// `kind` picks the color + default label; pass `label` to override the
// text while keeping the same color/size/shape (e.g. a specific RERA
// number instead of the generic "Verified" wording).
const KIND = {
  verified:   { icon: '✓', label: 'Verified',              color: '#2E9E4F', bg: '#E8F7EE' },
  // Previously named the specific external provider ("Verified ·
  // OpenStreetMap" / "Verified · Google Places") directly in end-user-
  // facing UI — removed per explicit instruction that provider/source
  // names must never render in the UI (they can stay attached to the
  // underlying data for internal verification, just not shown here). Both
  // collapse to the same generic "Verified" the plain `verified` kind
  // already uses — kept as separate keys (not merged into `verified`
  // itself) so call sites stay self-documenting about WHICH real source
  // backs a given field, without that distinction leaking into the label.
  map:        { icon: '✓', label: 'Verified',              color: '#2E9E4F', bg: '#E8F7EE' },
  places:     { icon: '✓', label: 'Verified',              color: '#2E9E4F', bg: '#E8F7EE' },
  ai:         { icon: '✦', label: 'AI-derived',             color: '#6B4FBB', bg: '#F1EDFB' },
  unverified: { icon: '⚠', label: 'Not found',              color: '#8A8896', bg: '#F6F5F1' },
}

export default function FieldBadge({ kind = 'unverified', label, compact = false }) {
  const k = KIND[kind] || KIND.unverified
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      background: k.bg, color: k.color, padding: compact ? '2px 6px' : '2px 7px', borderRadius: 4,
      fontSize: 10, fontWeight: 700, fontFamily: "'IBM Plex Mono',monospace",
      letterSpacing: '0.03em', flexShrink: 0, whiteSpace: 'nowrap',
    }}>
      {k.icon} {label || k.label}
    </span>
  )
}

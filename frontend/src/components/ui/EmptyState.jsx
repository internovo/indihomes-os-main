import React from 'react'
import { colors, font } from './tokens.js'

// One shared empty/unavailable-value treatment for the whole app (problem
// #4). Two modes:
//
// - `EmptyState` — block/card-level: an icon + a short reason, optional
//   longer `detail` line. Used when a whole CARD has nothing to show
//   (Sales Velocity "Not connected", Competitor Analysis "Not connected",
//   Nearby Infrastructure "No hospitals found nearby", etc).
// - `EmptyValue` — inline: a single muted span for one missing VALUE inside
//   a label:value row or a table cell (replaces bare "—", ad hoc
//   "Not published"/"Not found"/"Not yet fetched" text that previously
//   used three different grey shades and italic/non-italic inconsistently
//   from call site to call site). Defaults to "Not available"; accepts
//   children for the rare case where more specific wording is genuinely
//   useful ("No Google Trends data for this search term") — even then it's
//   pixel-identical in color/weight/style to every other EmptyValue.
//
// A REAL value that happens to be zero ("0 found nearby") is NOT an empty
// state — render it as a normal value, never through either of these.

// height:'100%' + centered — same "no-op unless the parent SectionCard is
// stretched taller than its own content by a paired-row sibling" pattern
// SectionCard itself already uses (see that component's own comment).
// Without this, a sparse empty state (Sales Velocity's "Not connected",
// Competitor Analysis's error state) rendered at its natural height
// pinned to the TOP of a body div CSS Grid had already stretched taller
// to match a richer sibling card — leaving a block of dead, unstyled
// blank space below it that reads as a layout bug, not an intentional
// empty state. Centering it in whatever height IS available makes a
// sparse card look deliberate instead of broken.
export function EmptyState({ icon = 'ⓘ', reason, detail }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: 56, padding: '18px 0' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', color: colors.muted, maxWidth: 440 }}>
        <span style={{ fontSize: 16, flexShrink: 0, lineHeight: '1.4' }}>{icon}</span>
        <div>
          <div style={{ fontSize: font.size.body, fontStyle: detail ? 'normal' : 'italic' }}>{reason}</div>
          {detail && <div style={{ fontSize: font.size.label, marginTop: 4, lineHeight: 1.6 }}>{detail}</div>}
        </div>
      </div>
    </div>
  )
}

export function EmptyValue({ children = 'Not available' }) {
  return (
    <span style={{ color: colors.muted, fontWeight: 500, fontStyle: 'normal' }}>
      {children}
    </span>
  )
}

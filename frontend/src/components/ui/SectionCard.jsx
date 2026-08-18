import React from 'react'
import { colors, font, radius } from './tokens.js'
import { isDebugMode } from './debug.js'

// The one bordered-card-with-a-label-header shape used everywhere (Project
// Intelligence, Project Selection, Lead Capture) — white background,
// rounded, optional colored left accent, a small uppercase mono section
// title, an optional badge next to it, and an optional action in the
// top-right corner (problem #6: every card's primary action now lives in
// the same place, not scattered top-right/bottom-right per card).
//
// `debugId` (e.g. "PI-FR-08") only renders when the page is opened with
// `?debug=1` — a small monospace tag visually separated from the title,
// never inline with it by default (problem #2).
//
// minWidth:0/maxWidth:100%/boxSizing:border-box guards against a CSS Grid
// item being forced wider than its column by a long unbroken word inside —
// no overflow:hidden, since some cards host popovers that render outside
// the card's own box.
// height:'100%' + flex column: a no-op wherever this card is the only thing
// in its row (the vast majority of call sites — a percentage height with no
// explicit-height ancestor just resolves to auto), but when a parent grid
// row stretches its items (CSS Grid's default align-items behavior — see
// ProjectIntelligence.jsx's paired-card rows), this is what lets a card
// actually fill that row instead of sizing to its own content and leaving
// its shorter sibling's bottom edge misaligned. The body wrapper gets
// flex:1 so extra stretched height lands in the content area, below the
// header, exactly where a taller sibling's content would have been.
export default function SectionCard({ title, debugId, badge, action, accent, style, bodyStyle, children }) {
  const debug = isDebugMode()
  return (
    <div style={{
      background: colors.white, border: `1px solid ${colors.border}`,
      borderLeft: accent ? `4px solid ${accent}` : `1px solid ${colors.border}`,
      borderRadius: radius.xl, padding: '16px 20px',
      minWidth: 0, maxWidth: '100%', boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column', height: '100%',
      ...style,
    }}>
      {(title || badge || action || (debug && debugId)) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 14, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
            {title && (
              <span style={{ fontSize: font.size.sm, fontFamily: font.mono, color: colors.muted, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                {title}
              </span>
            )}
            {badge}
            {debug && debugId && (
              <span style={{ fontSize: 9, fontFamily: font.mono, color: colors.mutedLight, background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 3, padding: '1px 5px', letterSpacing: '0.02em' }} title="Internal field ID — visible only in debug mode">
                {debugId}
              </span>
            )}
          </div>
          {action}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, ...bodyStyle }}>{children}</div>
    </div>
  )
}

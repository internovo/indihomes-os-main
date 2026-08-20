// Design tokens for propOG — this app has no Tailwind config (pure
// inline-style React), so these are plain JS constants used the same way
// Tailwind theme tokens would be. Values are redirects onto the CSS custom
// properties in `src/styles/tokens.css` (the actual source of truth,
// imported once in main.jsx) — never literal hex here, so this file and
// tokens.css can never drift apart into two palettes.

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
}

export const colors = {
  navy: 'var(--pg-surface-dark)',      // primary brand / headers / primary buttons
  navyHover: 'var(--pg-surface-dark-2)',
  navyText: 'var(--pg-ink)',           // near-black body text
  violet: 'var(--pg-indigo)',          // "AI-derived" accent
  violetLight: 'var(--pg-indigo-light)',
  green: 'var(--pg-green)',            // "Verified" / success / PRIMARY tier
  greenDark: 'var(--pg-green)',
  orange: 'var(--pg-gold)',            // SECONDARY tier / accent
  red: 'var(--pg-red)',                // error / Lost / TERTIARY-negative
  blue: 'var(--pg-indigo)',            // informational status accent
  teal: 'var(--pg-indigo)',
  amber: 'var(--pg-gold-deep)',
  muted: 'var(--pg-ink-3)',            // secondary text, empty-state copy, uppercase labels
  mutedLight: 'var(--pg-ink-4)',       // placeholder-weight text
  textSecondary: 'var(--pg-ink-2)',
  border: 'var(--pg-border)',
  borderLight: 'var(--pg-border)',
  bg: 'var(--pg-shell)',
  bgAlt: 'var(--pg-shell)',
  bgFaint: 'var(--pg-shell)',
  white: 'var(--pg-surface)',
}

// Fixed color-to-meaning mapping for FieldBadge/StatusPill — the single
// source of truth every screen's badges/pills must resolve through, so the
// same meaning is pixel-identical everywhere it appears.
export const semantic = {
  verified: colors.green,
  aiDerived: colors.violet,
  unverified: colors.muted,
}

export const font = {
  body: 'var(--pg-font)',
  mono: 'var(--pg-font-mono)',
  size: {
    xs: 10,
    sm: 11,
    label: 12,
    body: 13,
    md: 14,
    lg: 15,
    xl: 17,
    display: 22,
    hero: 25,
  },
}

export const radius = {
  xs: 5,   // micro chips
  sm: 6,   // badges, tag pills
  md: 8,   // filter chips, buttons
  lg: 9,   // nav items, topbar buttons
  inputR: 10, // inputs
  xl: 14,  // cards — SectionCard's own border-radius
  xxl: 16, // feature panels
  pill: 20,
  round: '50%',
}

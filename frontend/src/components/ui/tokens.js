// Design tokens for IndiHomes OS — this app has no Tailwind config (pure
// inline-style React), so these are plain JS constants used the same way
// Tailwind theme tokens would be: one place that defines "what navy/violet/
// green/grey/spacing ARE", so every screen references the same values
// instead of re-typing slightly-different hex codes and one-off pixel
// numbers. No new hues introduced — every color here is one already in use
// somewhere in the app before this pass; this only removes the drift
// between near-duplicate shades of the same intended color.

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
}

export const colors = {
  navy: '#0E0E52',       // primary brand / headers / primary buttons
  navyHover: '#1A1A6E',
  navyText: '#1B1B3A',   // near-black body text (not pure black, matches navy family)
  violet: '#6B4FBB',     // "AI-derived" accent — the one AI/derived-data color in the app
  violetLight: '#8B8BD6',
  green: '#2E9E4F',      // "Verified" / success / PRIMARY tier
  greenDark: '#156B35',
  orange: '#F7941D',     // SECONDARY tier / warning / CTA accent
  red: '#D64545',        // error / Lost / TERTIARY-negative
  blue: '#0E5FBF',       // informational status accent (Qualified, etc.)
  teal: '#0E9CBF',
  amber: '#C77D19',
  // Muted/neutral scale — three near-identical greys (#8A8896 / #B8B6C0 /
  // assorted italics) were previously used interchangeably for "muted
  // text"; standardized to exactly two roles.
  muted: '#8A8896',       // secondary text, empty-state copy, uppercase labels
  mutedLight: '#B8B6C0',  // placeholder-weight text (lighter than `muted`, still not `border`)
  textSecondary: '#75737F',
  border: '#E9E7E0',
  borderLight: '#F0EEE8',
  bg: '#F6F5F1',
  bgAlt: '#F9F8F6',
  bgFaint: '#FBFAF7',
  white: '#fff',
}

// Fixed color-to-meaning mapping for FieldBadge/StatusPill — the single
// source of truth every screen's badges/pills must resolve through, so the
// same meaning is pixel-identical everywhere it appears (problem #8).
export const semantic = {
  verified: colors.green,
  aiDerived: colors.violet,
  unverified: colors.muted,
}

export const font = {
  body: "'Plus Jakarta Sans',sans-serif",
  mono: "'IBM Plex Mono',monospace",
  size: {
    xs: 10,
    sm: 11,
    label: 12,
    body: 13,
    md: 14,
    lg: 15,
    xl: 17,
    display: 22,
    hero: 28,
  },
}

export const radius = {
  sm: 4,
  md: 6,
  lg: 8,
  xl: 12,
  pill: 20,
  round: '50%',
}

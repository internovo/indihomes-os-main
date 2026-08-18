// Internal ticket/field IDs (PI-FR-08, etc.) must never ship visible in the
// production UI (problem #2) — they're developer/QA references. Gated
// behind `?debug=1` in the URL; nothing else in the app reads this flag, so
// it has zero effect unless a developer explicitly opts in.
export function isDebugMode() {
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).get('debug') === '1'
  } catch {
    return false
  }
}

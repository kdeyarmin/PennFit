/**
 * Ambient backdrop — intentionally a no-op. The prior implementation
 * mounted floating navy/gold blooms, a fading gold rule, and a
 * diagonal lacquer sheen behind the landing page; in practice those
 * decorative layers read as gaudy on a medical storefront. The
 * component is kept in place so existing call sites don't churn,
 * but it now renders nothing. Brand colour belongs on actual UI
 * (CTAs, dividers, icons, callouts), not in a wall-to-wall wash.
 */
export function AmbientBackground() {
  return null;
}

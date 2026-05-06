import "./ambient-background.css";

/**
 * Classy ambient backdrop for the storefront landing page. Pure CSS,
 * no canvas, no grids, no cyan — just slow-drifting navy and gold
 * blooms, a soft cream wash, and a refined diagonal sheen with a
 * gold glint. Reads as luxury editorial print rather than a tech HUD.
 *
 * Sits fixed at z-index 0; the host page wraps its content in
 * `position: relative; z-index: 10` so it stacks above. All motion
 * is GPU-friendly (transform / background-position) and disabled
 * under prefers-reduced-motion.
 */
export function AmbientBackground() {
  return (
    <div
      className="ambient-bg"
      aria-hidden="true"
      data-testid="ambient-background"
    >
      <div className="ambient-bg__wash" />
      <div className="ambient-bg__bloom ambient-bg__bloom--navy-tl" />
      <div className="ambient-bg__bloom ambient-bg__bloom--navy-br" />
      <div className="ambient-bg__bloom ambient-bg__bloom--gold-tr" />
      <div className="ambient-bg__rule" />
      <div className="ambient-bg__sheen" />
    </div>
  );
}

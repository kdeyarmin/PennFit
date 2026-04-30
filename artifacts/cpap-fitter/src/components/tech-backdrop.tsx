import { useEffect } from "react";
import "./tech-backdrop.css";

/**
 * Brand-aligned ambient motion layer for customer-facing reminder
 * pages. Renders fixed-positioned navy/gold blobs + a faint perspective
 * grid + a slow lacquer sheen on top of the global background — it does
 * NOT replace the site-wide background (the cream/navy/gold mesh and
 * dot grid defined in index.css remain visible underneath), so the
 * reminders pages read as the same product as the rest of the site,
 * just with a touch more living motion.
 *
 * Page content should sit in a `position: relative; z-index: 1`
 * wrapper so it stacks above this layer.
 *
 * Animations are GPU-friendly (transform/opacity, background-position)
 * and disabled under `prefers-reduced-motion`.
 */
export function TechBackdrop() {
  useEffect(() => {
    document.body.classList.add("tech-backdrop-on");
    return () => {
      document.body.classList.remove("tech-backdrop-on");
    };
  }, []);

  return (
    <div className="tech-backdrop" aria-hidden="true" data-testid="tech-backdrop">
      <div className="tech-backdrop__base" />
      <div className="tech-backdrop__blob tech-backdrop__blob--a" />
      <div className="tech-backdrop__blob tech-backdrop__blob--b" />
      <div className="tech-backdrop__blob tech-backdrop__blob--c" />
      <div className="tech-backdrop__grid" />
      <div className="tech-backdrop__sweep" />
      <div className="tech-backdrop__noise" />
    </div>
  );
}

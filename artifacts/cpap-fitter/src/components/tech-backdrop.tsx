import { useEffect } from "react";
import "./tech-backdrop.css";

/**
 * Animated, high-tech background for customer-facing reminder pages.
 * Mounts a class on <body> while active so the global dot-grid /
 * film-grain pseudo-elements don't compound with the new layers, and
 * renders fixed-positioned blobs + grid + sweep + noise behind the
 * page content. Page content should sit in a `position: relative;
 * z-index: 1` wrapper so it stacks above the backdrop.
 *
 * Animations are GPU-friendly (transform/opacity) and disabled under
 * `prefers-reduced-motion`.
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

import { useEffect, useRef } from "react";
import "./tech-animated-background.css";

/**
 * Fixed-positioned animated tech backdrop. Renders four stacked layers:
 *
 *   1. Brand wash      — soft navy/cyan/gold radial gradients (CSS).
 *   2. Blueprint grid  — slow-drifting two-tone lattice (CSS keyframe).
 *   3. Particle network — canvas with floating nodes + distance-based
 *                         connecting lines, drawn each rAF tick.
 *   4. Lacquer sheen   — diagonal sweep with a cyan/gold kiss (CSS).
 *
 * The mounting page must wrap its content in a `position: relative;
 * z-index: 10` (or any positive z-index) container so it stacks above
 * this layer. Animations pause when the tab is hidden and degrade to a
 * single static frame under `prefers-reduced-motion`.
 */
export function TechAnimatedBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    const context2d = canvasEl.getContext("2d");
    if (!context2d) return;

    // Re-declare with non-nullable types — TS narrowing from `if (!x) return`
    // doesn't propagate into the nested function expressions defined below.
    const canvas: HTMLCanvasElement = canvasEl;
    const ctx: CanvasRenderingContext2D = context2d;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    type Node = {
      x: number;
      y: number;
      vx: number;
      vy: number;
      r: number;
      pulse: number;
    };

    let nodes: Node[] = [];
    let width = 0;
    let height = 0;
    let dpr = 1;
    let raf = 0;

    // Particle count scales with viewport area but is bounded — the
    // link-drawing loop is O(n^2) so unbounded scaling murders mobile.
    function targetCount() {
      const area = window.innerWidth * window.innerHeight;
      const count = Math.round(area / 19000);
      return Math.max(28, Math.min(90, count));
    }

    function seed() {
      const n = targetCount();
      nodes = Array.from({ length: n }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.22,
        vy: (Math.random() - 0.5) * 0.22,
        r: 1.1 + Math.random() * 1.6,
        pulse: Math.random() * Math.PI * 2,
      }));
    }

    function resize() {
      // Cap at 2x to keep memory bounded on 3x retina screens.
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (nodes.length === 0 || Math.abs(nodes.length - targetCount()) > 8) {
        seed();
      }
    }

    function readVar(name: string, fallback: string) {
      const v = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();
      return v || fallback;
    }

    const navy = readVar("--penn-navy", "222 60% 10%");
    const cyan = readVar("--penn-cyan", "198 92% 52%");
    const cyanDeep = readVar("--penn-cyan-deep", "204 95% 38%");

    function linkDistance() {
      return Math.min(Math.min(width, height) * 0.18, 170);
    }

    function frame(t: number) {
      const ld = linkDistance();
      const ld2 = ld * ld;

      ctx.clearRect(0, 0, width, height);

      for (const p of nodes) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < -10) p.x = width + 10;
        else if (p.x > width + 10) p.x = -10;
        if (p.y < -10) p.y = height + 10;
        else if (p.y > height + 10) p.y = -10;
      }

      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > ld2) continue;
          const ratio = 1 - Math.sqrt(d2) / ld;
          const alpha = 0.05 + ratio * 0.28;
          const hue = ratio > 0.6 ? cyanDeep : navy;
          ctx.strokeStyle = `hsla(${hue} / ${alpha.toFixed(3)})`;
          ctx.lineWidth = 0.5 + ratio * 0.7;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      const tt = t / 1000;
      for (const p of nodes) {
        const pulse = 0.5 + 0.5 * Math.sin(tt * 1.4 + p.pulse);
        const haloR = p.r * (3.2 + pulse * 1.8);
        const grad = ctx.createRadialGradient(
          p.x,
          p.y,
          p.r * 0.4,
          p.x,
          p.y,
          haloR,
        );
        grad.addColorStop(0, `hsla(${cyan} / ${(0.6 * pulse + 0.1).toFixed(3)})`);
        grad.addColorStop(1, `hsla(${cyan} / 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, haloR, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = `hsla(${cyanDeep} / 0.85)`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }

      raf = requestAnimationFrame(frame);
    }

    function start() {
      if (raf) return;
      raf = requestAnimationFrame(frame);
    }
    function stop() {
      if (!raf) return;
      cancelAnimationFrame(raf);
      raf = 0;
    }

    function onVisibility() {
      if (document.hidden) stop();
      else if (!reducedMotion) start();
    }

    resize();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);

    if (reducedMotion) {
      // Render one static frame so the layer is still visually present,
      // then leave it frozen.
      frame(0);
      stop();
    } else {
      start();
    }

    return () => {
      stop();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <div
      className="tech-animated-bg"
      aria-hidden="true"
      data-testid="tech-animated-bg"
    >
      <div className="tech-animated-bg__wash" />
      <div className="tech-animated-bg__grid" />
      <canvas ref={canvasRef} className="tech-animated-bg__canvas" />
      <div className="tech-animated-bg__sheen" />
    </div>
  );
}

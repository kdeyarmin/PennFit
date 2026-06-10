/**
 * Real-User Monitoring for Core Web Vitals.
 *
 * Collects LCP, CLS, INP (and secondarily FCP + TTFB) using the
 * web-vitals library — the same data Google uses for CWV scoring —
 * and pipes each metric fire-and-forget into the existing
 * /api/usage-events sink via track(). No new vendor or endpoint
 * required; regressions on the fitter or checkout are visible in
 * the same usage_events table used for funnel analytics.
 *
 * Called once from main.tsx after the React root renders so the
 * initial navigation's metrics are captured.
 */

import { onCLS, onFCP, onINP, onLCP, onTTFB } from "web-vitals";
import { track } from "./track";

export function reportWebVitals(): void {
  const path = location.pathname;

  const report = (
    name: "LCP" | "CLS" | "INP" | "FCP" | "TTFB",
    value: number,
    rating: "good" | "needs-improvement" | "poor",
    navigationType: string,
  ) =>
    track("web_vital", {
      name,
      value: Math.round(value),
      rating,
      navigationType,
      path,
    });

  onLCP(({ value, rating, navigationType }) =>
    report("LCP", value, rating, navigationType),
  );
  onCLS(({ value, rating, navigationType }) =>
    report("CLS", value, rating, navigationType),
  );
  onINP(({ value, rating, navigationType }) =>
    report("INP", value, rating, navigationType),
  );
  onFCP(({ value, rating, navigationType }) =>
    report("FCP", value, rating, navigationType),
  );
  onTTFB(({ value, rating, navigationType }) =>
    report("TTFB", value, rating, navigationType),
  );
}

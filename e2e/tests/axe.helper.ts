// Shared axe-core assertion for the e2e a11y specs (public route sweep,
// the fitter-funnel walk, and the authenticated admin sweep).
//
// Severity gate: axe categorises findings as
// `minor` / `moderate` / `serious` / `critical`. We fail on `serious` +
// `critical` only; the lower tiers tend to flag cosmetic-but-debatable
// issues (color contrast on hover states, alt-text on decorative
// imagery) and would create noisy red builds the team learns to ignore.
// Tightening the bar after the noisier findings are addressed is a
// one-line change here.

import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

const FAIL_ON: ReadonlyArray<"serious" | "critical"> = ["serious", "critical"];

/**
 * Run axe (WCAG 2.0/2.1 A + AA) against the page's current DOM and assert
 * there are no serious/critical violations. `label` is woven into the
 * failure message so a red build names the surface that regressed.
 */
export async function expectNoSeriousAxeViolations(
  page: Page,
  label: string,
): Promise<void> {
  const results = await new AxeBuilder({ page })
    // WCAG 2.1 AA is the canonical baseline for healthcare-adjacent web
    // surfaces. axe's `wcag2a` / `wcag2aa` / `wcag21a` / `wcag21aa` tags
    // map onto the underlying rule set.
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  const blocking = results.violations.filter((v) =>
    FAIL_ON.includes(v.impact as "serious" | "critical"),
  );

  const summary = blocking.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target).slice(0, 5),
  }));

  expect(
    blocking,
    `Axe found ${blocking.length} serious/critical violation(s) on ${label}:\n` +
      JSON.stringify(summary, null, 2),
  ).toHaveLength(0);
}

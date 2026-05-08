// Accessibility regression test (P3.2). Loads each major public
// SPA route, runs axe-core against the rendered DOM, and fails the
// suite if axe reports any serious or critical violations.
//
// Why public routes only: signed-in / admin pages need a session
// cookie to render. The login flow has its own e2e harness and the
// admin surface is gated by env-allowlist, so wiring authenticated
// paths into a CI a11y scan is a separate, larger piece of work.
// What we lock in here is "the marketing + storefront entry points
// don't regress". Authenticated-page coverage lands as a follow-up.
//
// Severity gate: axe categorises findings as
// `minor` / `moderate` / `serious` / `critical`. We fail on
// `serious` + `critical` only; the lower tiers tend to flag
// cosmetic-but-debatable issues (color contrast on hover states,
// alt-text on decorative imagery) and would create noisy red
// builds the team will learn to ignore. Tightening the bar after
// the noisier findings are addressed is a one-line change.

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const PUBLIC_ROUTES: ReadonlyArray<{ path: string; label: string }> = [
  { path: "/", label: "home" },
  { path: "/shop", label: "shop" },
  { path: "/consent", label: "consent" },
  { path: "/contact", label: "contact" },
  { path: "/admin/sign-in", label: "admin sign-in" },
];

const FAIL_ON: ReadonlyArray<"serious" | "critical"> = ["serious", "critical"];

for (const { path, label } of PUBLIC_ROUTES) {
  test(`${label} (${path}) has no serious/critical axe violations`, async ({
    page,
  }) => {
    await page.goto(path, { waitUntil: "networkidle" });

    const results = await new AxeBuilder({ page })
      // WCAG 2.1 AA is the canonical baseline for healthcare-adjacent
      // public web surfaces. axe's `wcag2a` / `wcag2aa` / `wcag21a` /
      // `wcag21aa` tags map onto the underlying rule set.
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    const blocking = results.violations.filter((v) =>
      FAIL_ON.includes(v.impact as "serious" | "critical"),
    );

    // Format violations for the failure message; AssertionError on the
    // length keeps the diff small while still telling the developer
    // which rule + which selector caused the failure.
    const summary = blocking.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.map((n) => n.target).slice(0, 5),
    }));

    expect(
      blocking,
      `Axe found ${blocking.length} serious/critical violation(s) on ${path}:\n` +
        JSON.stringify(summary, null, 2),
    ).toHaveLength(0);
  });
}

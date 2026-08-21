// Storefront e2e: the CareMetric Breathe marketing surface (`/breathe`).
//
// Why this exists: the platform marketing pages had NO e2e coverage at all —
// the suite targets the storefront and the fitter funnel, so a broken
// `/breathe` chunk, an unreachable header, or a footer link pointing at a
// dead route would all have shipped green. That gap is what let a
// nav-breakpoint regression through: the header's mega-menus hide at
// <=1080px, but the hamburger that replaces them only appeared at <=900px,
// so between 901px and 1080px the page had no reachable navigation at all.
// `navigation is reachable at every breakpoint` below is that regression,
// pinned.
//
// Harness assumptions — this must stay green in the backend-less `smoke` /
// `a11y` jobs (`vite preview`, no Express API):
//   * The pricing band calls the public pricing endpoint and falls back to
//     the compile-time PLANS when it 404s, so the section still renders.
//   * Everything else on the page is static.
// Both are why the assertions below never touch live data.

import { expect, test, type Page } from "@playwright/test";

/** Widths that bracket every nav breakpoint, plus the narrowest phone. */
const BREAKPOINTS = [1440, 1280, 1081, 1080, 1024, 900, 768, 390, 320];

/**
 * Console noise that is an artifact of the backend-less harness rather than
 * a page defect. Chromium logs every 4xx as an error-level message; the
 * storefront smoke spec filters the same way and for the same reason.
 */
function collectRealErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (text.startsWith("Failed to load resource:")) return;
    errors.push(text);
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

test("landing page renders the fitter-led hero without runtime errors", async ({
  page,
}) => {
  const errors = collectRealErrors(page);

  await page.goto("/breathe", { waitUntil: "networkidle" });

  // The hero headline is the page's whole positioning; if the lazy chunk
  // failed to mount we would fall through to an empty shell.
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /fit every patient/i,
  );

  // The mask-fitter band is the flagship section this page is built around.
  await expect(page.locator("#fitter")).toBeVisible();
  await expect(page.locator("#how")).toBeVisible();

  expect(
    errors,
    "The Breathe landing page emitted browser-console errors:\n" +
      errors.join("\n"),
  ).toHaveLength(0);
});

test("navigation is reachable at every breakpoint", async ({ page }) => {
  await page.goto("/breathe", { waitUntil: "networkidle" });

  for (const width of BREAKPOINTS) {
    await page.setViewportSize({ width, height: 900 });
    // Let the media queries settle before measuring.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const visible = (sel: string) =>
              [...document.querySelectorAll(sel)].filter(
                (el) => el.getBoundingClientRect().width > 0,
              ).length;
            // Either the desktop mega-menus OR the hamburger must be on
            // screen. Neither means the site map is unreachable.
            return visible(".bx-nav-mega") > 0 || visible(".bx-nav-toggle") > 0;
          }),
        {
          message: `No reachable navigation at ${width}px — the mega-menus and the hamburger are both hidden`,
        },
      )
      .toBe(true);

    // The page itself must never scroll sideways. The integrations marquee
    // is deliberately wider than the viewport, but it lives inside an
    // overflow-hidden, masked container, so it must not widen the document.
    const overflow = await page.evaluate(() => {
      const de = document.documentElement;
      return de.scrollWidth - de.clientWidth;
    });
    expect(
      overflow,
      `Horizontal page overflow of ${overflow}px at ${width}px wide`,
    ).toBeLessThanOrEqual(1);
  }
});

test("the four header mega-menus open and expose their deep dives", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/breathe", { waitUntil: "networkidle" });

  for (const label of ["Platform", "Mask fitter", "Why Breathe", "Trust"]) {
    const trigger = page.getByRole("button", { name: new RegExp(label, "i") });
    await trigger.hover();
    const panel = page.locator(".bx-nav-mega-panel");
    await expect(panel, `${label} menu did not open`).toBeVisible();
    // Every entry is a real link, not a placeholder.
    const links = panel.locator("a");
    expect(
      await links.count(),
      `${label} menu opened but exposed no links`,
    ).toBeGreaterThan(3);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
  }

  // The fitter menu is the differentiator; spot-check that it routes to the
  // deep dive rather than a generic features page.
  await page.getByRole("button", { name: /mask fitter/i }).hover();
  await expect(
    page.locator(".bx-nav-mega-panel").getByRole("link", {
      name: /clinical mask fitting/i,
    }),
  ).toHaveAttribute("href", "/breathe/mask-fitting");
});

test("the mobile panel exposes the grouped sitemap with tappable targets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/breathe", { waitUntil: "networkidle" });

  await page.getByRole("button", { name: /open menu/i }).click();

  // Four labelled groups, fitter first.
  const groups = page.locator(".bx-nav-mob-title");
  await expect(groups).toHaveCount(4);
  await expect(groups.first()).toHaveText(/mask fitter/i);

  const links = page.locator(".bx-nav-mob-link");
  expect(await links.count()).toBeGreaterThan(20);

  // WCAG 2.5.5 target size — the panel is the only way to navigate on a
  // phone, so its rows must stay comfortably tappable.
  const shortest = await page.evaluate(() =>
    Math.min(
      ...[...document.querySelectorAll(".bx-nav-mob-link")].map(
        (el) => el.getBoundingClientRect().height,
      ),
    ),
  );
  expect(
    shortest,
    "A mobile nav row is under the 44px tap target",
  ).toBeGreaterThanOrEqual(44);
});

test("every header and footer link resolves to a real route", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/breathe", { waitUntil: "networkidle" });

  // Collect the footer sitemap plus every mega-menu entry. The footer is
  // the full site map now, so a typo'd href here soft-404s into NotFound
  // and quietly costs a crawlable page.
  const hrefs = await page.evaluate(async () => {
    const found = new Set<string>();
    for (const a of document.querySelectorAll<HTMLAnchorElement>(
      ".bx-footer-col a",
    )) {
      found.add(a.getAttribute("href") ?? "");
    }
    // Open each mega-menu in turn so its links are in the DOM.
    for (const btn of document.querySelectorAll<HTMLButtonElement>(
      ".bx-nav-mega-btn",
    )) {
      btn.click();
      await new Promise((r) => setTimeout(r, 60));
      for (const a of document.querySelectorAll<HTMLAnchorElement>(
        ".bx-nav-mega-panel a",
      )) {
        found.add(a.getAttribute("href") ?? "");
      }
    }
    return [...found].filter((h) => h.startsWith("/"));
  });

  expect(
    hrefs.length,
    "Collected no navigation links — the selectors have drifted",
  ).toBeGreaterThan(20);

  for (const href of hrefs) {
    // Strip the in-page anchor; `/breathe#how` is the same document.
    const path = href.split("#")[0] || "/breathe";
    await page.goto(path, { waitUntil: "domcontentloaded" });
    // NotFound sets this exact title (src/pages/not-found.tsx), which makes
    // it a stabler signal than scraping the 404 body copy.
    await expect(page, `${href} fell through to NotFound`).not.toHaveTitle(
      /page not found/i,
    );
  }
});

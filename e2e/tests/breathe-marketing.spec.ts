// Storefront e2e: the CareMetric Breathe marketing surface (`/breathe`).
//
// Why this exists: the platform marketing pages had NO e2e coverage at all —
// the suite targets the storefront and the fitter funnel, so a broken
// `/breathe` chunk, an unreachable header, or a footer link pointing at a
// dead route would all have shipped green.
//
// That gap let two nav-breakpoint regressions through in a row, and
// `navigation is reachable at every breakpoint` below pins both:
//   1. The mega-menus were hidden at <=1080px while the hamburger that
//      replaces them only appeared at <=900px, so 901-1080px had no
//      reachable navigation at all.
//   2. The 1080px figure was then itself wrong: the full header row needs
//      1170px, so 1081-1170px silently CLIPPED the rightmost CTA (89px of
//      it at 1081px). `.breathe-page` sets `overflow-x: clip`, which keeps
//      that out of `documentElement.scrollWidth` entirely — so the first
//      version of the overflow assertion could not see it.
// Both are why the header collapses at 1200px today and why the test
// measures each nav item's right edge rather than trusting scrollWidth.
//
// Harness assumptions — this must stay green in the backend-less `smoke` /
// `a11y` jobs (`vite preview`, no Express API):
//   * The pricing band calls the public pricing endpoint and falls back to
//     the compile-time PLANS when it 404s, so the section still renders.
//   * Everything else on the page is static.
// Both are why the assertions below never touch live data.

import { expect, test, type Page } from "@playwright/test";

/** Widths that bracket every nav breakpoint, plus the narrowest phone. */
const BREAKPOINTS = [
  1440, 1280, 1201, 1200, 1170, 1100, 1024, 900, 768, 390, 320,
];

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

    // A scrollWidth check alone is NOT enough for the header. `.breathe-page`
    // sets `overflow-x: clip`, so a nav row that is too wide gets silently
    // cut off without ever widening the document — the CTA can be most of
    // the way off-screen while the check above still reads zero. Measure
    // each visible nav item against the shell's inner edge instead.
    const clipped = await page.evaluate(() => {
      const row = document.querySelector(".bx-nav-inner");
      if (!row) return { over: 0, who: "" };
      const rect = row.getBoundingClientRect();
      const innerRight =
        rect.right - (parseFloat(getComputedStyle(row).paddingRight) || 0);
      let over = 0;
      let who = "";
      const sel = ".bx-nav-mega,.bx-nav-plain,.bx-nav-signin,.bx-btn";
      for (const el of row.querySelectorAll(sel)) {
        const b = el.getBoundingClientRect();
        if (b.width === 0) continue;
        if (b.right - innerRight > over) {
          over = Math.round(b.right - innerRight);
          who = (el.textContent ?? "").trim().slice(0, 24);
        }
      }
      return { over, who };
    });
    expect(
      clipped.over,
      `Nav item "${clipped.who}" is clipped by ${clipped.over}px at ${width}px wide — collapse to the mobile panel before this width`,
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
  // deep dive rather than a generic features page, and that the referral
  // entry deep-links its own section instead of repeating that URL.
  await page.getByRole("button", { name: /mask fitter/i }).hover();
  const fitterPanel = page.locator(".bx-nav-mega-panel");
  await expect(
    fitterPanel.getByRole("link", { name: /clinical mask fitting/i }),
  ).toHaveAttribute("href", "/breathe/mask-fitting");
  await expect(
    fitterPanel.getByRole("link", { name: /provider referral portal/i }),
  ).toHaveAttribute("href", "/breathe/mask-fitting#referrals");
});

test("a keyboard-opened mega-menu closes when focus leaves it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/breathe", { waitUntil: "networkidle" });

  // Open by keyboard rather than hover — there is no onMouseLeave to save
  // us here, so without a focus-out handler the panel stays open over the
  // page for the rest of the visit.
  const trigger = page.getByRole("button", { name: /^Platform/i });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".bx-nav-mega-panel")).toBeVisible();

  // Tab until focus leaves the menu subtree.
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => {
      const mega = document.activeElement?.closest(".bx-nav-mega");
      return mega !== null && mega !== undefined;
    });
    if (!inside) break;
  }

  await expect(
    page.locator(".bx-nav-mega-panel"),
    "The mega-menu stayed open after focus left it",
  ).toBeHidden();
});

test("the header's in-page hash link scrolls when already on /breathe", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/breathe", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.scrollY)).toBeLessThan(50);

  // "How it works" is /breathe#how, rendered through a wouter <Link>.
  // Wouter pushState's it, which performs no native anchor jump, and the
  // mount-time hash effect has already run — so without an explicit scroll
  // the URL changes and the page sits still.
  await page.getByRole("button", { name: /^Platform/i }).hover();
  await page
    .locator(".bx-nav-mega-panel")
    .getByRole("link", { name: /how it works/i })
    .click();

  await expect
    .poll(() => page.evaluate(() => window.scrollY), {
      message: "Clicking the header's #how link did not scroll the page",
      timeout: 10_000,
    })
    .toBeGreaterThan(200);
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
  // ~26 destinations, each a separate lazy chunk the dev server transforms
  // on first request. Comfortably inside Playwright's 30s default locally,
  // but not on a cold CI runner — so give it explicit room rather than let
  // it flake.
  test.setTimeout(120_000);
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

    if (path.startsWith("/breathe")) {
      // Positive proof, not the absence of a 404 title. Every marketing
      // route renders through BreatheShell's `.breathe-page` wrapper;
      // NotFound is a top-level route and never does. Asserting the
      // wrapper appeared means the intended lazy route actually mounted.
      //
      // The earlier version asserted `not.toHaveTitle(/page not found/)`
      // straight after domcontentloaded, which passed against the static
      // shell title before any route had mounted — so a misspelled href
      // would have sailed through. A negative assertion cannot wait for
      // something to *not* happen; this positive one can.
      await expect(
        page.locator(".breathe-page"),
        `${href} did not render a Breathe route — it fell through to NotFound`,
      ).toBeVisible({ timeout: 15_000 });
    } else {
      // The one non-marketing destination (/admin/sign-in). It has no
      // `.breathe-page` wrapper and never calls useDocumentTitle, so wait
      // for its sign-in form to prove the route mounted.
      await expect(
        page.locator("form, input[type='password']").first(),
        `${href} did not render a sign-in form`,
      ).toBeVisible({ timeout: 15_000 });
    }

    // Belt and braces: NotFound sets this exact title.
    await expect(page, `${href} fell through to NotFound`).not.toHaveTitle(
      /page not found/i,
    );
  }
});

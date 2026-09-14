import { expect, test, type BrowserContext } from "@playwright/test";

// All application API traffic is synthetic. These checks cannot create an order,
// contact a patient, or access the backend configured for another local task.
async function pricingFixture(context: BrowserContext, manager: boolean) {
  const expiresAt = "2099-12-31T23:59:59.999Z";
  const policy = {
    id: "30000000-0000-4000-8000-000000000001",
    version: 1,
    name: "Fixture policy",
    effectiveFrom: "2020-01-01T00:00:00.000Z",
    expiresAt,
    createdAt: "2020-01-01T00:00:00.000Z",
    createdBy: "fixture",
    rules: {
      targetMarginBps: 4000,
      floorMarginBps: 2500,
      basis: "contribution",
    },
  };
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!["localhost", "127.0.0.1"].includes(url.hostname))
      return route.abort();
    if (!/^\/(api|resupply-api)\//.test(url.pathname)) return route.continue();
    const send = (json: unknown) => route.fulfill({ json });
    if (url.pathname.endsWith("/auth/me"))
      return send({
        id: "pricing-fixture-user",
        email: "pricing@example.test",
        displayName: "Pricing Reviewer",
        role: "admin",
        emailVerified: true,
        mustChangePassword: false,
      });
    if (url.pathname === "/resupply-api/me")
      return send({
        userId: "pricing-fixture-user",
        email: "pricing@example.test",
        role: "admin",
        permissions: [
          "pricing.evaluate",
          ...(manager
            ? [
                "pricing.manage",
                "pricing.approve",
                "pricing.publish",
                "inventory.read",
                "admin.tools.manage",
              ]
            : []),
        ],
        pendingAgreements: [],
        productScope: "full",
      });
    if (url.pathname.endsWith("/pricing/state"))
      return send({
        revision: 1,
        enabled: true,
        enforceQuotes: true,
        policy,
        activePriceListId: null,
      });
    if (url.pathname.endsWith("/pricing/policies"))
      return send({ policies: [policy], hasMore: false });
    if (url.pathname.endsWith("/pricing/active-prices"))
      return send({ batch: null });
    if (url.pathname.endsWith("/pricing/portfolio"))
      return send({
        items: [
          {
            sku: "FIXTURE-MASK",
            name: "Fixture mask",
            category: "mask",
            offers: [],
            hasMoreOffers: false,
            activeEntries: [],
          },
        ],
        hasMore: false,
      });
    if (url.pathname.endsWith("/admin/catalog/products"))
      return send({
        products: [
          {
            sku: "FIXTURE-MASK",
            name: "Fixture mask",
            description: null,
            category: "mask",
            manufacturer: null,
            modelNumber: null,
            unitOfMeasure: "each",
            stockCount: null,
            lowStockThreshold: null,
            lowStock: false,
            active: true,
            updatedAt: "2026-09-14T00:00:00Z",
          },
        ],
        total: 1,
        categories: ["mask"],
      });
    if (url.pathname.endsWith("/pricing/offers"))
      return send({ offers: [], hasMore: false });
    if (url.pathname.endsWith("/pricing/revenue-profiles"))
      return send({ profiles: [], hasMore: false });
    if (url.pathname.endsWith("/pricing/quotes"))
      return send({ quotes: [], hasMore: false });
    if (url.pathname.endsWith("/pricing/summary")) return send({ groups: [] });
    if (url.pathname.endsWith("/pricing/proposals"))
      return send({ proposals: [], hasMore: false });
    if (url.pathname.endsWith("/pricing/alerts")) return send({ alerts: [] });
    if (url.pathname.endsWith("/pricing/batches"))
      return send({ batches: [], hasMore: false });
    if (url.pathname.includes("/auth/mfa"))
      return send({ mustEnroll: false, enabled: false });
    return send({
      items: [],
      counts: {},
      notifications: [],
      unreadCount: 0,
      flags: [],
      templates: [],
      ok: true,
    });
  });
}

test("pricing workspace stays within a narrow viewport with usable named controls", async ({
  context,
  page,
}) => {
  await pricingFixture(context, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/pricing");
  await expect(
    page.getByRole("heading", { name: "Pricing & Profitability", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Pricing portfolio", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Review FIXTURE-MASK", exact: true })
    .click();
  await expect(page.getByLabel("Item 1 description")).toHaveValue(
    "Fixture mask",
  );
  await expect(
    page.getByLabel("Item 1 billed / scenario unit amount ($)"),
  ).toBeVisible();
  const width = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  expect(width.document).toBeLessThanOrEqual(width.viewport + 1);
  await page
    .getByRole("button", { name: "Supplier costs", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Add a supplier offer", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Pricing policy", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save draft policy", exact: true }),
  ).toBeVisible();
  for (const [tab, heading] of [
    ["New items", "Propose a new item"],
    ["Bulk prices", "Preview a bulk price change"],
  ]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
    if (tab === "New items") {
      await page
        .getByRole("button", { name: "Compare provisional supplier costs" })
        .click();
      await page.getByLabel("Comparison requested units").fill("7");
      await page.getByLabel("Supplier 1 units per pack").fill("6");
      await page.getByLabel("Supplier 1 purchase pack cost ($)").fill("12.00");
      await expect(
        page.getByText("Known subtotal $24.00", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Buy 2 packs · 12 purchased units · 5 surplus units"),
      ).toBeVisible();
      await expect(
        page
          .getByLabel("Comparison for supplier 1", { exact: true })
          .getByText("Cost information needed", { exact: true }),
      ).toBeVisible();
    }
    const panelWidth = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: innerWidth,
    }));
    expect(panelWidth.document).toBeLessThanOrEqual(panelWidth.viewport + 1);
  }
});

test("CSR pricing access provides review without manager publishing controls", async ({
  context,
  page,
}) => {
  await pricingFixture(context, false);
  await page.goto("/admin/pricing");
  await expect(
    page.getByRole("heading", { name: "Pricing & Profitability", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Pricing policy", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save draft policy", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Publish this policy", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Supplier costs", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Supplier offers", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save supplier offer", exact: true }),
  ).toHaveCount(0);
});

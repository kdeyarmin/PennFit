import { expect, test, type BrowserContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  analyzeOwnerProfitModels,
  type OwnerProfitAssumptions,
} from "../../lib/resupply-domain/src/owner-profit-models";
import {
  evaluatePricing,
  type PricingInput,
} from "../../lib/resupply-domain/src/pricing";
import type {
  Quote,
  Scenario,
} from "../../lib/api-client-react/src/admin/pricing";

// All application API traffic is synthetic. These checks cannot create an order,
// contact a patient, or access the backend configured for another local task.
async function pricingFixture(
  context: BrowserContext,
  manager: boolean,
  ownerReviews = false,
) {
  const ownerRequests: Array<{
    scenario: Scenario;
    assumptions: OwnerProfitAssumptions;
  }> = [];
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
      basis: "contribution" as const,
    },
  };
  // Hypothetical single-order economics: $100 revenue - $60 goods - $10
  // freight = $30 contribution. These are test inputs, never business defaults.
  const input: PricingInput = {
    currency: "USD",
    evaluatedAt: "2026-09-14T12:00:00.000Z",
    lines: [
      {
        id: "owner-line",
        sku: "FIXTURE-MASK",
        quantity: 1,
        unitPriceCents: 10000,
        unitCostCents: 6000,
        costStatus: "verified",
        costExpiresAt: expiresAt,
      },
    ],
    costs: [
      {
        id: "freight",
        label: "Fixture freight",
        category: "freight",
        basis: "order",
        amountCents: 1000,
        status: "verified",
        expiresAt,
      },
    ],
    revenue: { mode: "self_pay", shippingChargedCents: 0 },
    policy: policy.rules,
  };
  const scenario: Scenario = {
    validUntil: expiresAt,
    lines: [
      {
        id: "owner-line",
        sku: "FIXTURE-MASK",
        description: "Owner fixture mask",
        quantity: 1,
        unitAmountCents: 10000,
        fulfillmentMethod: "dropship",
        offerId: "40000000-0000-4000-8000-000000000001",
        offerVersion: 1,
      },
    ],
    revenue: { mode: "self_pay", shippingChargedCents: 0 },
  };
  const resolved = {
    scenario,
    input,
    evaluation: evaluatePricing(input),
    dependencies: [
      {
        offerId: scenario.lines[0].offerId,
        version: scenario.lines[0].offerVersion,
        expiresAt,
      },
    ],
    policyId: policy.id,
    policyVersion: 1,
  };
  const quote: Quote = {
    ...resolved,
    id: "50000000-0000-4000-8000-000000000001",
    revision: 1,
    status: "draft",
    patientId: null,
    lines: scenario.lines.map((line) => ({ ...line, unitCostCents: 6000 })),
    validUntil: expiresAt,
    approvedBy: null,
    approvedAt: null,
    boundOrderId: null,
    createdAt: input.evaluatedAt,
    updatedAt: input.evaluatedAt,
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
    if (url.pathname.endsWith("/pricing/owner-models")) {
      if (!manager)
        return route.fulfill({ status: 403, json: { error: "forbidden" } });
      const body = route
        .request()
        .postDataJSON() as (typeof ownerRequests)[number];
      ownerRequests.push(body);
      return send({
        resolved,
        models: analyzeOwnerProfitModels(input, body.assumptions),
      });
    }
    if (ownerReviews && url.pathname.endsWith(`/pricing/quotes/${quote.id}`))
      return send(quote);
    if (url.pathname.endsWith("/pricing/quotes"))
      return send({
        quotes:
          ownerReviews && Number(url.searchParams.get("offset")) > 0
            ? [quote]
            : [],
        hasMore: ownerReviews && Number(url.searchParams.get("offset")) === 0,
      });
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
  return { ownerRequests, resolved };
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
  await expect(
    page.getByRole("button", { name: "Owner models", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Use in owner models", exact: true }),
  ).toHaveCount(0);
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

test("a manager calculates owner models from a paged saved review on a narrow screen", async ({
  context,
  page,
}) => {
  const { ownerRequests, resolved } = await pricingFixture(context, true, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/pricing");
  await page.getByRole("button", { name: "Owner models", exact: true }).click();
  for (const name of [
    "Owner models",
    "Pricing strategies",
    "Monthly break-even & profit",
    "Cost & collection stress",
    "Price versus volume",
    "Repeat orders & acquisition",
    "Working capital",
  ]) {
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
  }
  const monthly = page.locator("section").filter({
    has: page.getByRole("heading", {
      name: "Monthly break-even & profit",
      exact: true,
    }),
  });
  const calculateMonthly = monthly.getByRole("button", {
    name: "Calculate monthly break-even & profit",
    exact: true,
  });
  await expect(calculateMonthly).toBeDisabled();
  await page
    .getByRole("button", { name: "Next saved scenarios", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Next saved scenarios", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Saved review for owner models", { exact: true })
    .selectOption("50000000-0000-4000-8000-000000000001");
  await expect(
    page.getByText("1 × Owner fixture mask (FIXTURE-MASK)", { exact: true }),
  ).toBeVisible();
  await calculateMonthly.click();
  await expect(
    monthly.getByText("More information needed", { exact: true }),
  ).toBeVisible();
  expect(ownerRequests[0]?.assumptions).toEqual({ monthly: {} });
  await page
    .getByLabel("Monthly fixed costs ($)", { exact: true })
    .fill("300.00");
  await page.getByLabel("Assumed monthly orders", { exact: true }).fill("20");
  await page
    .getByLabel("Monthly profit target ($)", { exact: true })
    .fill("300.00");
  await calculateMonthly.click();
  await expect(monthly.getByText("Calculated", { exact: true })).toBeVisible();
  await expect(
    monthly
      .getByText("Break-even orders per month", { exact: true })
      .locator(".."),
  ).toContainText("10");
  await expect(
    monthly
      .getByText("Orders to reach profit target", { exact: true })
      .locator(".."),
  ).toContainText("20");
  await expect(
    monthly
      .getByText("Projected monthly profit", { exact: true })
      .locator(".."),
  ).toContainText("$300.00");
  expect(ownerRequests[1]?.assumptions).toEqual({
    monthly: { fixedCostCents: 30000, orders: 20, targetProfitCents: 30000 },
  });

  await page.getByLabel("Assumed monthly orders", { exact: true }).fill("10");
  await expect(
    monthly.getByText("Projected monthly profit", { exact: true }),
  ).toHaveCount(0);
  await calculateMonthly.click();
  await expect(
    monthly
      .getByText("Projected monthly profit", { exact: true })
      .locator(".."),
  ).toContainText("$0.00");
  for (const [label, value] of [
    ["Planning period (days)", "30"],
    ["Assumed orders during this period", "20"],
    ["Cash paid out per order ($)", "70.00"],
    ["Days held in inventory", "0"],
    ["Days until customer / insurer collection", "45"],
    ["Days until vendor payment", "15"],
  ])
    await page.getByLabel(label, { exact: true }).fill(value);
  const capital = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Working capital", exact: true }),
  });
  await capital
    .getByRole("button", { name: "Calculate working capital", exact: true })
    .click();
  await expect(
    capital.getByText("Uses estimated inputs", { exact: true }),
  ).toBeVisible();
  await expect(
    capital.getByText("Funding gap (days)", { exact: true }).locator(".."),
  ).toContainText("30");
  await expect(
    capital
      .getByText("Estimated funding required", { exact: true })
      .locator(".."),
  ).toContainText("$1,400.00");
  expect(ownerRequests[3]?.assumptions).toEqual({
    workingCapital: {
      periodDays: 30,
      orders: 20,
      cashOutlayPerOrderCents: 7000,
      inventoryDays: 0,
      daysToCollect: 45,
      daysToPayVendor: 15,
    },
  });
  const width = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  expect(width.document).toBeLessThanOrEqual(width.viewport + 1);
  const report = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download scenario report", exact: true })
    .click();
  const downloadedReport = await report;
  expect(downloadedReport.suggestedFilename()).toBe(
    "owner-planning-scenarios.csv",
  );
  const reportPath = await downloadedReport.path();
  expect(reportPath).not.toBeNull();
  const csv = await readFile(reportPath!, "utf8");
  const supplier = resolved.dependencies[0];
  for (const model of ["Monthly break-even & profit", "Working capital"]) {
    expect(csv).toContain(
      `"${model}","Source review","Pricing policy ID","${resolved.policyId}"`,
    );
    expect(csv).toContain(
      `"${model}","Source review","Pricing policy version","${resolved.policyVersion}"`,
    );
    expect(csv).toContain(
      `"${model}","Source review","Evidence valid through","${resolved.scenario.validUntil}"`,
    );
    expect(csv).toContain(
      `"${model}","Result","Calculated at","${resolved.input.evaluatedAt}"`,
    );
    expect(csv).toContain(
      `"${model}","Source item","Item and quantity","1 × Owner fixture mask (FIXTURE-MASK)"`,
    );
    expect(csv).toContain(
      `"${model}","1 × Owner fixture mask (FIXTURE-MASK)","Baseline unit price","$100.00"`,
    );
    expect(csv).toContain(
      `"${model}","Supplier source for FIXTURE-MASK","Offer ID","${supplier.offerId}"`,
    );
    expect(csv).toContain(
      `"${model}","Supplier source for FIXTURE-MASK","Offer version","${supplier.version}"`,
    );
    expect(csv).toContain(
      `"${model}","Supplier source for FIXTURE-MASK","Evidence expiry","${supplier.expiresAt}"`,
    );
  }
  expect(csv).toContain(
    '"Monthly break-even & profit","Assumption","Assumed monthly orders","10"',
  );
  expect(csv).toContain(
    '"Monthly break-even & profit","Monthly break-even & profit","Projected monthly contribution","$300.00"',
  );
  expect(csv).toContain(
    '"Monthly break-even & profit","Monthly break-even & profit","Projected monthly profit","$0.00"',
  );
  expect(csv).not.toContain(
    '"Monthly break-even & profit","Monthly break-even & profit","Projected monthly profit","$300.00"',
  );
  expect(csv).toContain(
    '"Working capital","Working capital","Funding gap (days)","30"',
  );
  expect(csv).toContain(
    '"Working capital","Working capital","Estimated funding required","$1,400.00"',
  );
  // Switching tabs keeps entered assumptions and current results without a new request.
  await page
    .getByRole("button", { name: "Pricing policy", exact: true })
    .click();
  await page.getByRole("button", { name: "Owner models", exact: true }).click();
  await expect(
    page.getByLabel("Assumed monthly orders", { exact: true }),
  ).toHaveValue("10");
  await expect(
    capital
      .getByText("Estimated funding required", { exact: true })
      .locator(".."),
  ).toContainText("$1,400.00");
  expect(ownerRequests).toHaveLength(4);
});

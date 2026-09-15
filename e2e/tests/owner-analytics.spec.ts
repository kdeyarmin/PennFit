import { expect, test, type BrowserContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { ownerAnalyticsFixture } from "../../artifacts/cpap-fitter/src/pages/admin/owner-analytics.fixture";

// All API requests use synthetic aggregates; no patient or vendor is contacted.
async function overviewFixture(context: BrowserContext, manager = true) {
  const state = { requests: [] as string[], partial: false, failed: false };
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!["localhost", "127.0.0.1"].includes(url.hostname))
      return route.abort();
    if (!/^\/(api|resupply-api)\//.test(url.pathname)) return route.continue();
    const send = (json: unknown) => route.fulfill({ json });
    if (url.pathname.endsWith("/auth/me"))
      return send({
        id: "owner-fixture-user",
        email: "owner@example.test",
        displayName: "Owner",
        role: "admin",
        emailVerified: true,
        mustChangePassword: false,
      });
    if (url.pathname === "/resupply-api/me")
      return send({
        userId: "owner-fixture-user",
        email: "owner@example.test",
        role: "admin",
        permissions: manager
          ? ["metrics.read", "cost.read", "module.analytics", "module.catalog"]
          : ["patients.read"],
        pendingAgreements: [],
        productScope: "full",
      });
    if (url.pathname.endsWith("/admin/analytics/owner")) {
      state.requests.push(url.search);
      if (state.failed)
        return route.fulfill({
          status: 503,
          json: { error: "owner_analytics_unavailable" },
        });
      const report = ownerAnalyticsFixture();
      if (url.searchParams.has("from")) {
        const from = Date.parse(`${url.searchParams.get("from")}T00:00:00Z`);
        const to =
          Date.parse(`${url.searchParams.get("to")}T00:00:00Z`) + 86400000;
        report.window = {
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          previousFrom: new Date(2 * from - to).toISOString(),
          previousTo: new Date(from).toISOString(),
        };
      }
      const dates: string[] = [];
      for (
        let time = Date.parse(`${report.window.from.slice(0, 10)}T00:00:00Z`);
        time < Date.parse(report.window.to);
        time += 86_400_000
      )
        dates.push(new Date(time).toISOString().slice(0, 10));
      if (report.business.status === "available") {
        const b = report.business.data;
        Object.assign(b.current, {
          episodesOpened: 3,
          fulfillmentLinesQueued: 4,
          claimsCreated: 3,
          claimBilledCents: 45000,
          claimPaidToDateCents: 30000,
          outboundMessages: 3,
          inboundMessages: 1,
          deliveredMessages: 2,
          failedMessages: 1,
        });
        b.orderRequestStages.push({ status: "draft", count: 3 });
        b.claimStages.push({
          status: "paid",
          count: 2,
          billedCents: 35000,
          paidCents: 30000,
        });
        b.daily = dates.map((date, i) => ({
          date,
          orderRequestsCreated: i === dates.length - 1 ? 8 : 0,
          orderRequestsSigned: i === dates.length - 1 ? 5 : 0,
          episodesOpened: i === dates.length - 1 ? 3 : 0,
          shipmentLinesRecorded: i === dates.length - 1 ? 4 : 0,
          patientsAdded: i === dates.length - 1 ? 12 : 0,
        }));
      }
      if (report.financial.status === "available")
        report.financial.data.daily = dates.map((date, i) => ({
          date,
          revenueCents: i === dates.length - 1 ? 10000 : 0,
          costCents: i === dates.length - 1 ? 6000 : 0,
          eventCount: i === dates.length - 1 ? 3 : 0,
        }));
      if (state.partial)
        report.financial = {
          status: "unavailable",
          message:
            "Financial records are temporarily unavailable. Retry to load current figures.",
        };
      return send(report);
    }
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
  return state;
}

test("owner overview exposes the business areas, accessible charts and a source-labelled export", async ({
  context,
  page,
}, testInfo) => {
  const state = await overviewFixture(context);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/admin/analytics/owner");
  for (const title of [
    "Owner overview",
    "Where to focus now",
    "Recorded financial activity",
    "Completed-review contribution",
    "Patients & order activity",
    "Patient & resupply queues",
    "Claims & payer activity",
    "Products & fulfillment",
    "Stock to review",
    "Outreach & patient response",
    "Sources, coverage & definitions",
  ])
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
  expect(state.requests).toEqual(["?days=30"]);
  const navigation = page.getByRole("navigation", {
    name: "Overview sections",
  });
  for (const [name, id] of [
    ["Claims", "claims"],
    ["Products & stock", "products"],
    ["Outreach", "outreach"],
  ]) {
    const link = navigation.getByRole("link", { name, exact: true });
    await expect(link).toHaveAttribute("href", `#${id}`);
    await link.click();
    await expect(page.locator(`#${id}`)).toBeInViewport();
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("owner-desktop.png"),
    fullPage: false,
  });
  await page.screenshot({
    path: testInfo.outputPath("owner-full-page.png"),
    fullPage: true,
  });
  const financial = page.getByRole("region", {
    name: "Recorded financial activity",
    exact: true,
  });
  await financial
    .getByRole("button", { name: "Show data table", exact: true })
    .click();
  await expect(financial.getByRole("table")).toContainText("$100.00");
  await financial
    .getByRole("button", { name: "Show chart", exact: true })
    .click();
  const accessibility = await new AxeBuilder({ page })
    .include('[data-testid="owner-analytics-page"]')
    .analyze();
  expect(accessibility.violations).toEqual([]);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download overview CSV", exact: true })
    .click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe("owner-overview-2026-09-14.csv");
  const csv = await readFile((await file.path())!, "utf8");
  for (const evidence of [
    "2026-08-15T12:00:00.000Z",
    "Synthetic payer",
    "MASK-A",
    "Completed financial reviews",
    "From (inclusive)",
  ])
    expect(csv).toContain(evidence);
});

test("mobile filters suppress stale exports and partial failures preserve useful business figures", async ({
  context,
  page,
}, testInfo) => {
  const state = await overviewFixture(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/analytics/owner");
  const download = page.getByRole("button", {
    name: "Download overview CSV",
    exact: true,
  });
  await expect(download).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("owner-mobile.png") });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page
    .getByRole("combobox", { name: "Reporting period" })
    .selectOption("custom");
  await expect(download).toBeDisabled();
  await expect(
    page.getByRole("heading", {
      name: "Patients & order activity",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByLabel("Start date (UTC)", { exact: true }).fill("2026-01-03");
  await page.getByLabel("End date (UTC)", { exact: true }).fill("2026-01-01");
  await expect(
    page.getByRole("button", { name: "Apply dates", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Start date (UTC)", { exact: true }).fill("2026-01-01");
  await page.getByLabel("End date (UTC)", { exact: true }).fill("2026-01-03");
  await page.getByRole("button", { name: "Apply dates", exact: true }).click();
  await expect(download).toBeEnabled();
  expect(state.requests.at(-1)).toBe("?from=2026-01-01&to=2026-01-03");
  state.partial = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Financial activity unavailable",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Patients & order activity",
      exact: true,
    }),
  ).toBeVisible();
  await expect(download).toBeEnabled();
  const downloaded = page.waitForEvent("download");
  await download.click();
  const csv = await readFile((await (await downloaded).path())!, "utf8");
  expect(csv).toContain("2026-01-04T00:00:00.000Z");
  expect(csv).toContain("unavailable");
  expect(csv).not.toContain("Completed financial reviews");
  state.failed = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(download).toBeDisabled();
  await expect(
    page.getByRole("heading", {
      name: "Patients & order activity",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("a CSR cannot request or view owner financial analytics", async ({
  context,
  page,
}) => {
  const state = await overviewFixture(context, false);
  await page.goto("/admin/analytics/owner");
  await expect(
    page.getByText(
      "Owner analytics requires management and financial reporting access.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(state.requests).toHaveLength(0);
  await expect(
    page.getByRole("button", { name: "Download overview CSV", exact: true }),
  ).toHaveCount(0);
});

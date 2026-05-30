// Tests for the low-stock alert dispatcher.
//
// Covers the dedup/cooldown state machine described in migration 0142
// and the worker comment block in `low-stock-alerts.ts`:
//   * Stripe unconfigured       → log + skip, no DB writes.
//   * No SKUs below threshold   → resolve sweep runs but no alert sent.
//   * First-ever alert          → SKU emails out + state row upserted.
//   * Cooldown suppression      → recent alert within 24h is skipped.
//   * Recovery + re-dip         → resolved row + later dip alerts again.
//   * Empty RESUPPLY_ADMIN_EMAILS → state still upserted, no send.
//
// We mock Stripe at the `getStripeClient` boundary (consistent with
// `shop-products.test.ts`) and the email client at the
// `@workspace/resupply-email` boundary (consistent with
// `fitter-lead-reengage.test.ts`).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// SendGrid stub. The worker calls `createSendgridClient()` lazily, so
// throwing `EmailConfigError` from the factory simulates an
// unconfigured environment. Defined via vi.hoisted so it's available
// during the hoisted mock factory.
const { sendEmailMock, sendgridShouldThrow, FakeEmailConfigError } = vi.hoisted(
  () => {
    class FakeEmailConfigError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "EmailConfigError";
      }
    }
    return {
      sendEmailMock: vi.fn<(args: unknown) => Promise<undefined>>(
        async () => undefined,
      ),
      sendgridShouldThrow: { current: false },
      FakeEmailConfigError,
    };
  },
);
vi.mock("@workspace/resupply-email", () => ({
  EmailConfigError: FakeEmailConfigError,
  createSendgridClient: () => {
    if (sendgridShouldThrow.current) {
      throw new FakeEmailConfigError("SENDGRID_API_KEY is required");
    }
    return { sendEmail: sendEmailMock };
  },
}));

// Stripe stub — same fluent shape as `shop-products.test.ts`.
const { stripeListMock, stripeConfiguredRef } = vi.hoisted(() => ({
  stripeListMock: vi.fn(),
  stripeConfiguredRef: { current: true },
}));
vi.mock("../../lib/stripe/config", () => ({
  readStripeConfigOrNull: () =>
    stripeConfiguredRef.current ? { secretKey: "sk_test_x" } : null,
  getStripeClient: () => ({
    products: {
      list: (...a: unknown[]) => stripeListMock(...a),
    },
  }),
}));

// Project every Stripe product into the canonical ShopProductView the
// worker iterates. The worker only reads `id`, `name`, `stockCount`,
// and `lowStockThreshold`, so we stub a minimal projection.
vi.mock("../../lib/stripe/products-meta", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/stripe/products-meta")
  >("../../lib/stripe/products-meta");
  return {
    ...actual,
    projectProduct: (raw: {
      id: string;
      name?: string;
      metadata?: { stock_count?: string; low_stock_threshold?: string };
    }) => {
      const meta = raw.metadata ?? {};
      const stock = meta.stock_count;
      const threshold = meta.low_stock_threshold;
      return {
        id: raw.id,
        name: raw.name ?? raw.id,
        description: null,
        category: "accessory",
        tagline: null,
        isBundle: false,
        bundleContents: [],
        replacementHint: null,
        imageUrl: null,
        manufacturer: null,
        modelNumber: null,
        stockCount: stock === undefined ? null : Number(stock),
        lowStockThreshold: threshold === undefined ? null : Number(threshold),
        price: { id: "price_x", unitAmount: 1000, currency: "usd" },
        recurringPrice: null,
      };
    },
  };
});

import { runLowStockAlerts } from "./low-stock-alerts";

function stripeProduct(
  id: string,
  name: string,
  stockCount: number | null,
  lowStockThreshold: number | null = null,
) {
  const metadata: Record<string, string> = {};
  if (stockCount !== null) metadata.stock_count = String(stockCount);
  if (lowStockThreshold !== null) {
    metadata.low_stock_threshold = String(lowStockThreshold);
  }
  return { id, name, metadata };
}

function stageSingleStripePage(products: ReturnType<typeof stripeProduct>[]) {
  stripeListMock.mockResolvedValueOnce({
    data: products,
    has_more: false,
  });
}

const originalAdminEmails = process.env.RESUPPLY_ADMIN_EMAILS;

beforeEach(() => {
  supabaseMock.reset();
  sendEmailMock.mockClear();
  stripeListMock.mockReset();
  stripeConfiguredRef.current = true;
  sendgridShouldThrow.current = false;
  process.env.RESUPPLY_ADMIN_EMAILS = "ops@penn.example,owner@penn.example";
});

afterEach(() => {
  if (originalAdminEmails === undefined) {
    delete process.env.RESUPPLY_ADMIN_EMAILS;
  } else {
    process.env.RESUPPLY_ADMIN_EMAILS = originalAdminEmails;
  }
});

describe("runLowStockAlerts: short-circuit branches", () => {
  it("returns the zero-stat envelope when Stripe is not configured", async () => {
    stripeConfiguredRef.current = false;
    const stats = await runLowStockAlerts();
    expect(stats).toEqual({
      scanned: 0,
      belowThreshold: 0,
      newAlerts: 0,
      cooldownSkipped: 0,
      resolved: 0,
      recipients: 0,
      emailSent: false,
    });
    expect(stripeListMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    // No Supabase writes when we short-circuit at config time.
    expect(getSupabaseCallCount("low_stock_alert_state", "upsert")).toBe(0);
    expect(getSupabaseCallCount("low_stock_alert_state", "update")).toBe(0);
  });

  it("returns early when every SKU is comfortably above its threshold", async () => {
    // Two SKUs, both well above threshold. The worker still runs the
    // recovery sweep on `low_stock_alert_state` (no rows in our
    // fixture) but should not query for alert state or send email.
    stageSingleStripePage([
      stripeProduct("prod_A", "Mask", 50, 5),
      stripeProduct("prod_B", "Filter", 30, 5),
    ]);
    stageSupabaseResponse("low_stock_alert_state", "update", { data: [] });

    const stats = await runLowStockAlerts();
    expect(stats.scanned).toBe(2);
    expect(stats.belowThreshold).toBe(0);
    expect(stats.newAlerts).toBe(0);
    expect(stats.emailSent).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
    // No upsert when we didn't try to alert.
    expect(getSupabaseCallCount("low_stock_alert_state", "upsert")).toBe(0);
  });
});

describe("runLowStockAlerts: first-ever alert", () => {
  it("emails every recipient and upserts state for the alertable SKUs", async () => {
    stageSingleStripePage([
      stripeProduct("prod_LOW", "Pillows Cushion", 2, 5),
      stripeProduct("prod_HIGH", "Mask Frame", 40, 5),
    ]);
    // Recovery sweep — prod_HIGH might recover, but no state rows exist.
    stageSupabaseResponse("low_stock_alert_state", "update", { data: [] });
    // Alert-eligibility lookup — no prior state for prod_LOW.
    stageSupabaseResponse("low_stock_alert_state", "select", { data: [] });
    // State upsert returns empty success envelope.
    stageSupabaseResponse("low_stock_alert_state", "upsert", { data: null });

    const stats = await runLowStockAlerts();

    expect(stats.scanned).toBe(2);
    expect(stats.belowThreshold).toBe(1);
    expect(stats.newAlerts).toBe(1);
    expect(stats.cooldownSkipped).toBe(0);
    expect(stats.recipients).toBe(2);
    expect(stats.emailSent).toBe(true);

    // Both recipients got the digest.
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    const firstCallArgs = sendEmailMock.mock.calls[0]?.[0] as {
      to: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(firstCallArgs.subject).toContain("1 SKU below threshold");
    expect(firstCallArgs.text).toContain("Pillows Cushion");
    expect(firstCallArgs.text).toContain("2 on hand");
    // The above-threshold SKU should not appear in the digest body.
    expect(firstCallArgs.text).not.toContain("Mask Frame");

    // State upsert carries last_alerted_at + clears last_resolved_at.
    const upserts = getSupabaseWritePayloads(
      "low_stock_alert_state",
      "upsert",
    ) as Array<Record<string, unknown>[]>;
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toHaveLength(1);
    expect(upserts[0]![0]).toMatchObject({
      product_id: "prod_LOW",
      last_observed_count: 2,
      last_threshold: 5,
      last_resolved_at: null,
    });
    expect(typeof upserts[0]![0]!.last_alerted_at).toBe("string");
  });

  it("uses the default threshold of 5 when the SKU has no per-SKU override", async () => {
    // No low_stock_threshold metadata → default 5. stockCount=5 IS
    // at-or-below threshold.
    stageSingleStripePage([stripeProduct("prod_X", "Tubing", 5, null)]);
    stageSupabaseResponse("low_stock_alert_state", "update", { data: [] });
    stageSupabaseResponse("low_stock_alert_state", "select", { data: [] });
    stageSupabaseResponse("low_stock_alert_state", "upsert", { data: null });

    const stats = await runLowStockAlerts();
    expect(stats.belowThreshold).toBe(1);
    expect(stats.newAlerts).toBe(1);
    expect(sendEmailMock).toHaveBeenCalled();
  });

  it("treats lowStockThreshold=0 as an explicit opt-out, no alert", async () => {
    // Threshold of 0 means "don't alert on this SKU ever".
    stageSingleStripePage([stripeProduct("prod_OPT_OUT", "Wipes", 0, 0)]);
    stageSupabaseResponse("low_stock_alert_state", "update", { data: [] });

    const stats = await runLowStockAlerts();
    expect(stats.belowThreshold).toBe(0);
    expect(stats.newAlerts).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("skips SKUs whose stockCount is null (untracked)", async () => {
    stageSingleStripePage([
      stripeProduct("prod_UNTRACKED", "Mystery", null, 5),
    ]);
    stageSupabaseResponse("low_stock_alert_state", "update", { data: [] });

    const stats = await runLowStockAlerts();
    expect(stats.belowThreshold).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("runLowStockAlerts: cooldown + recovery", () => {
  it("suppresses an alert that fired less than 24h ago", async () => {
    stageSingleStripePage([
      stripeProduct("prod_RECENT", "Recent Alert SKU", 1, 5),
    ]);
    // Recovery sweep finds no recovered SKUs.
    stageSupabaseResponse("low_stock_alert_state", "update", { data: [] });
    // Existing alert state — last alerted 2h ago, never resolved.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    stageSupabaseResponse("low_stock_alert_state", "select", {
      data: [
        {
          product_id: "prod_RECENT",
          last_alerted_at: twoHoursAgo,
          last_resolved_at: null,
        },
      ],
    });

    const stats = await runLowStockAlerts();
    expect(stats.belowThreshold).toBe(1);
    expect(stats.cooldownSkipped).toBe(1);
    expect(stats.newAlerts).toBe(0);
    expect(stats.emailSent).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
    // No state upsert when nothing alerted.
    expect(getSupabaseCallCount("low_stock_alert_state", "upsert")).toBe(0);
  });

  it("re-alerts past the 24h cooldown window", async () => {
    stageSingleStripePage([
      stripeProduct("prod_STALE", "Stale Alert SKU", 1, 5),
    ]);
    stageSupabaseResponse("low_stock_alert_state", "update", { data: [] });
    // Last alert was 30h ago — past the 24h cooldown, still no resolve.
    const thirtyHoursAgo = new Date(
      Date.now() - 30 * 60 * 60 * 1000,
    ).toISOString();
    stageSupabaseResponse("low_stock_alert_state", "select", {
      data: [
        {
          product_id: "prod_STALE",
          last_alerted_at: thirtyHoursAgo,
          last_resolved_at: null,
        },
      ],
    });
    stageSupabaseResponse("low_stock_alert_state", "upsert", { data: null });

    const stats = await runLowStockAlerts();
    expect(stats.newAlerts).toBe(1);
    expect(stats.cooldownSkipped).toBe(0);
    expect(stats.emailSent).toBe(true);
    expect(sendEmailMock).toHaveBeenCalled();
  });

  it("re-alerts after recovery + re-dip even when within the 24h window", async () => {
    stageSingleStripePage([stripeProduct("prod_REDIP", "Re-dipped SKU", 2, 5)]);
    stageSupabaseResponse("low_stock_alert_state", "update", { data: [] });
    // last_resolved_at > last_alerted_at → fresh dip, bypasses cooldown.
    const tenHoursAgo = new Date(
      Date.now() - 10 * 60 * 60 * 1000,
    ).toISOString();
    const fiveHoursAgo = new Date(
      Date.now() - 5 * 60 * 60 * 1000,
    ).toISOString();
    stageSupabaseResponse("low_stock_alert_state", "select", {
      data: [
        {
          product_id: "prod_REDIP",
          last_alerted_at: tenHoursAgo,
          last_resolved_at: fiveHoursAgo,
        },
      ],
    });
    stageSupabaseResponse("low_stock_alert_state", "upsert", { data: null });

    const stats = await runLowStockAlerts();
    expect(stats.newAlerts).toBe(1);
    expect(stats.cooldownSkipped).toBe(0);
    expect(sendEmailMock).toHaveBeenCalled();
    // Upsert sets last_resolved_at: null on the new alert so a future
    // recovery sweep can re-stamp it.
    const upserts = getSupabaseWritePayloads(
      "low_stock_alert_state",
      "upsert",
    ) as Array<Record<string, unknown>[]>;
    expect(upserts[0]![0]).toMatchObject({
      product_id: "prod_REDIP",
      last_resolved_at: null,
    });
  });

  it("alerts again after a prior run marks the SKU as resolved", async () => {
    // Run 1: SKU recovered above threshold, so we stamp last_resolved_at.
    stageSingleStripePage([stripeProduct("prod_BOUNCE", "Bounce SKU", 20, 5)]);
    stageSupabaseResponse("low_stock_alert_state", "update", {
      data: [{ product_id: "prod_BOUNCE" }],
    });

    const recoveredStats = await runLowStockAlerts();
    expect(recoveredStats.resolved).toBe(1);
    expect(recoveredStats.newAlerts).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();

    // Run 2: same SKU dips again; state reflects resolved > alerted,
    // so it is eligible immediately (no cooldown suppression).
    stageSingleStripePage([stripeProduct("prod_BOUNCE", "Bounce SKU", 1, 5)]);
    stageSupabaseResponse("low_stock_alert_state", "update", { data: [] });
    const tenHoursAgo = new Date(
      Date.now() - 10 * 60 * 60 * 1000,
    ).toISOString();
    const fiveHoursAgo = new Date(
      Date.now() - 5 * 60 * 60 * 1000,
    ).toISOString();
    stageSupabaseResponse("low_stock_alert_state", "select", {
      data: [
        {
          product_id: "prod_BOUNCE",
          last_alerted_at: tenHoursAgo,
          last_resolved_at: fiveHoursAgo,
        },
      ],
    });
    stageSupabaseResponse("low_stock_alert_state", "upsert", { data: null });

    const redipStats = await runLowStockAlerts();
    expect(redipStats.newAlerts).toBe(1);
    expect(redipStats.cooldownSkipped).toBe(0);
    expect(redipStats.emailSent).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
  });

  it("stamps last_resolved_at when a previously-alerted SKU recovers above threshold", async () => {
    // The SKU is above threshold now — it shouldn't appear in `below`
    // but SHOULD be in `recoveredIds` so the worker can stamp
    // last_resolved_at. We assert the .update() call landed on the
    // state table.
    stageSingleStripePage([
      stripeProduct("prod_RECOVERED", "Recovered SKU", 20, 5),
    ]);
    stageSupabaseResponse("low_stock_alert_state", "update", {
      data: [{ product_id: "prod_RECOVERED" }],
    });

    const stats = await runLowStockAlerts();
    expect(stats.resolved).toBe(1);
    expect(stats.belowThreshold).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(getSupabaseCallCount("low_stock_alert_state", "update")).toBe(1);
  });
});

describe("runLowStockAlerts: recipient + transport guards", () => {
  it("skips delivery but still upserts state when RESUPPLY_ADMIN_EMAILS is empty", async () => {
    process.env.RESUPPLY_ADMIN_EMAILS = "";
    stageSingleStripePage([stripeProduct("prod_QUIET", "Quiet SKU", 1, 5)]);
    stageSupabaseResponse("low_stock_alert_state", "update", { data: [] });
    stageSupabaseResponse("low_stock_alert_state", "select", { data: [] });
    stageSupabaseResponse("low_stock_alert_state", "upsert", { data: null });

    const stats = await runLowStockAlerts();
    expect(stats.belowThreshold).toBe(1);
    expect(stats.newAlerts).toBe(1);
    expect(stats.recipients).toBe(0);
    expect(stats.emailSent).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
    // Critical: state IS upserted so the next tick honours the
    // cooldown for the SKU we computed as alertable, otherwise we'd
    // recompute the same alert forever and never make progress.
    expect(getSupabaseCallCount("low_stock_alert_state", "upsert")).toBe(1);
  });

  it("returns cleanly when the email client is unconfigured", async () => {
    sendgridShouldThrow.current = true;
    stageSingleStripePage([stripeProduct("prod_LOW2", "Low SKU 2", 1, 5)]);
    stageSupabaseResponse("low_stock_alert_state", "update", { data: [] });
    stageSupabaseResponse("low_stock_alert_state", "select", { data: [] });

    const stats = await runLowStockAlerts();
    expect(stats.belowThreshold).toBe(1);
    expect(stats.newAlerts).toBe(1);
    expect(stats.emailSent).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
    // No upsert when the email client failed to construct — we abort
    // before stamping state.
    expect(getSupabaseCallCount("low_stock_alert_state", "upsert")).toBe(0);
  });
});

describe("runLowStockAlerts: pagination", () => {
  it("paginates through Stripe products via starting_after until has_more is false", async () => {
    // Two-page catalog: first page has_more=true, then the worker
    // calls list() again with the cursor.
    stripeListMock.mockResolvedValueOnce({
      data: [stripeProduct("prod_P1", "Page-1 SKU", 50, 5)],
      has_more: true,
    });
    stripeListMock.mockResolvedValueOnce({
      data: [stripeProduct("prod_P2", "Page-2 SKU", 1, 5)],
      has_more: false,
    });
    stageSupabaseResponse("low_stock_alert_state", "update", { data: [] });
    stageSupabaseResponse("low_stock_alert_state", "select", { data: [] });
    stageSupabaseResponse("low_stock_alert_state", "upsert", { data: null });

    const stats = await runLowStockAlerts();
    expect(stripeListMock).toHaveBeenCalledTimes(2);
    // Second call must pass starting_after with the last id of page 1.
    const secondCallArgs = stripeListMock.mock.calls[1]?.[0] as {
      starting_after?: string;
    };
    expect(secondCallArgs.starting_after).toBe("prod_P1");
    // The SKU on page 2 is the one that should alert.
    expect(stats.scanned).toBe(2);
    expect(stats.belowThreshold).toBe(1);
    expect(stats.newAlerts).toBe(1);
  });
});

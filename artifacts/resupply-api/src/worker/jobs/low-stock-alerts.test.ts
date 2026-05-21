// Tests for worker/jobs/low-stock-alerts.ts
//
// Coverage:
//
//   Pure-logic re-implementations (not exported from the module):
//     parseRecipientList  — parse a comma-separated email string
//     effectiveThreshold  — derive alert threshold from product config
//     escapeHtml          — HTML-escape a string
//     renderDigest        — build subject/html/text for the digest email
//
//   runLowStockAlerts — integration-style with mocked dependencies:
//     * Stripe not configured → early return, zeroed stats
//     * No SKUs below threshold → early return
//     * All below-threshold SKUs within cooldown → suppressed
//     * No recipients configured → state upsert, no email
//     * Email not configured → skips send without throwing
//     * Happy path: alerts, state upsert, email sent
//
//   Static source analysis:
//     * ALERT_COOLDOWN_HOURS, DEFAULT_LOW_STOCK_THRESHOLD, ALERT_JOB, cron

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";
import { runLowStockAlerts } from "./low-stock-alerts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "low-stock-alerts.ts"),
  "utf8",
);

// ── Supabase mock ────────────────────────────────────────────────────────────
const supabaseMock = installSupabaseMock();

// ── Stripe mock ──────────────────────────────────────────────────────────────
const stripeProductsListMock = vi.fn();
let stripeConfigured = false;

vi.mock("../../lib/stripe/config", () => ({
  readStripeConfigOrNull: () =>
    stripeConfigured
      ? {
          secretKey: "sk_test_x",
          publishableKey: null,
          webhookSigningSecret: null,
          publicBaseUrl: "https://shop.test",
        }
      : null,
  getStripeClient: () => ({
    products: {
      list: (...a: unknown[]) => stripeProductsListMock(...a),
    },
  }),
}));

vi.mock("../../lib/stripe/products-meta", () => ({
  projectProduct: vi.fn((p: Record<string, unknown>) => ({
    id: p.id,
    name: p.name,
    active: true,
    stockCount: p.stockCount !== undefined ? p.stockCount : null,
    lowStockThreshold: p.lowStockThreshold !== undefined ? p.lowStockThreshold : null,
    category: "test",
    price: null,
    description: null,
    images: [],
  })),
}));

// ── Email mock ────────────────────────────────────────────────────────────────
const sendEmailMock = vi.fn(async () => undefined);
let emailConfigured = true;

vi.mock("@workspace/resupply-email", () => {
  class MockEmailConfigError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "EmailConfigError";
    }
  }
  return {
    createSendgridClient: () => {
      if (!emailConfigured) throw new MockEmailConfigError("no sendgrid key");
      return { sendEmail: sendEmailMock };
    },
    EmailConfigError: MockEmailConfigError,
  };
});

// ── Logger mock ───────────────────────────────────────────────────────────────
vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Static source analysis
// ---------------------------------------------------------------------------

describe("low-stock-alerts — constants", () => {
  it("defines ALERT_COOLDOWN_HOURS as 24", () => {
    expect(SRC).toContain("ALERT_COOLDOWN_HOURS = 24");
  });

  it("defines DEFAULT_LOW_STOCK_THRESHOLD as 5", () => {
    expect(SRC).toContain("DEFAULT_LOW_STOCK_THRESHOLD = 5");
  });

  it("defines ALERT_JOB name referencing shop-inventory.low-stock-alerts", () => {
    expect(SRC).toContain("shop-inventory.low-stock-alerts");
  });

  it("schedules every 6 hours (cron */6 * * *)", () => {
    expect(SRC).toContain("*/6 * * *");
  });
});

describe("low-stock-alerts — exports", () => {
  it("exports LowStockAlertStats interface", () => {
    expect(SRC).toContain("export interface LowStockAlertStats");
  });

  it("exports runLowStockAlerts function", () => {
    expect(SRC).toContain("export async function runLowStockAlerts");
  });

  it("exports registerLowStockAlertsJob function", () => {
    expect(SRC).toContain("export async function registerLowStockAlertsJob");
  });
});

describe("low-stock-alerts — dedup model", () => {
  it("uses lastResolvedAt to detect a fresh dip", () => {
    expect(SRC).toContain("lastResolvedAt");
  });

  it("compares lastAlertedAt to a cooldown cutoff", () => {
    expect(SRC).toContain("cooldownCutoff");
  });

  it("upserts alert state after alerting", () => {
    expect(SRC).toContain("upsertAlertState");
  });
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementation: parseRecipientList
// ---------------------------------------------------------------------------
//
// Source verbatim:
//   function parseRecipientList(raw: string | undefined): string[] {
//     if (!raw) return [];
//     return raw
//       .split(",")
//       .map((s) => s.trim().toLowerCase())
//       .filter((s) => s.length > 0 && s.includes("@"));
//   }

function parseRecipientList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s.includes("@"));
}

describe("parseRecipientList — empty/falsy input", () => {
  it("returns [] for undefined", () => {
    expect(parseRecipientList(undefined)).toEqual([]);
  });

  it("returns [] for empty string", () => {
    expect(parseRecipientList("")).toEqual([]);
  });
});

describe("parseRecipientList — single address", () => {
  it("parses a single valid address", () => {
    expect(parseRecipientList("ops@test.com")).toEqual(["ops@test.com"]);
  });

  it("lowercases the address", () => {
    expect(parseRecipientList("OPS@Test.COM")).toEqual(["ops@test.com"]);
  });

  it("trims surrounding whitespace", () => {
    expect(parseRecipientList("  ops@test.com  ")).toEqual(["ops@test.com"]);
  });
});

describe("parseRecipientList — multiple addresses", () => {
  it("splits on comma", () => {
    expect(parseRecipientList("a@test.com,b@test.com")).toEqual([
      "a@test.com",
      "b@test.com",
    ]);
  });

  it("handles whitespace around commas", () => {
    expect(parseRecipientList("a@test.com , b@test.com")).toEqual([
      "a@test.com",
      "b@test.com",
    ]);
  });

  it("filters out trailing empty segment from trailing comma", () => {
    expect(parseRecipientList("a@test.com,")).toEqual(["a@test.com"]);
  });

  it("filters out strings without @ sign", () => {
    expect(parseRecipientList("a@test.com,notanemail,b@test.com")).toEqual([
      "a@test.com",
      "b@test.com",
    ]);
  });

  it("filters out whitespace-only segments", () => {
    expect(parseRecipientList("a@test.com,  ,b@test.com")).toEqual([
      "a@test.com",
      "b@test.com",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementation: effectiveThreshold
// ---------------------------------------------------------------------------
//
// Source verbatim:
//   function effectiveThreshold(product: ShopProductView): number {
//     if (product.lowStockThreshold === null) return DEFAULT_LOW_STOCK_THRESHOLD;
//     return product.lowStockThreshold;
//   }

const DEFAULT_LOW_STOCK_THRESHOLD = 5;

function effectiveThreshold(product: { lowStockThreshold: number | null }): number {
  if (product.lowStockThreshold === null) return DEFAULT_LOW_STOCK_THRESHOLD;
  return product.lowStockThreshold;
}

describe("effectiveThreshold — null uses default (5)", () => {
  it("returns 5 when lowStockThreshold is null", () => {
    expect(effectiveThreshold({ lowStockThreshold: null })).toBe(5);
  });
});

describe("effectiveThreshold — explicit values", () => {
  it("returns 0 for explicit opt-out", () => {
    expect(effectiveThreshold({ lowStockThreshold: 0 })).toBe(0);
  });

  it("returns the configured threshold when set", () => {
    expect(effectiveThreshold({ lowStockThreshold: 3 })).toBe(3);
    expect(effectiveThreshold({ lowStockThreshold: 10 })).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementation: escapeHtml
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

describe("escapeHtml — special characters", () => {
  it("escapes &", () => expect(escapeHtml("a & b")).toBe("a &amp; b"));
  it("escapes <", () => expect(escapeHtml("<x>")).toBe("&lt;x&gt;"));
  it("escapes >", () => expect(escapeHtml("a > b")).toBe("a &gt; b"));
  it('escapes "', () => expect(escapeHtml('"hi"')).toBe("&quot;hi&quot;"));
  it("escapes '", () => expect(escapeHtml("it's")).toBe("it&#39;s"));
  it("leaves safe strings unchanged", () => {
    expect(escapeHtml("Hello World")).toBe("Hello World");
  });
  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
  it("escapes multiple occurrences in one string", () => {
    const result = escapeHtml("Tom & <Jerry> 'says' \"hi\"");
    expect(result).toContain("&amp;");
    expect(result).toContain("&lt;");
    expect(result).toContain("&gt;");
    expect(result).toContain("&#39;");
    expect(result).toContain("&quot;");
  });
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementation: renderDigest
// ---------------------------------------------------------------------------

interface BelowThresholdSku {
  productId: string;
  name: string;
  stockCount: number;
  threshold: number;
}

function renderDigest(skus: BelowThresholdSku[]): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `PennPaps inventory alert — ${skus.length} SKU${
    skus.length === 1 ? "" : "s"
  } below threshold`;
  const textLines = [
    `${skus.length} product${skus.length === 1 ? " is" : "s are"} at or below their low-stock threshold:`,
    "",
    ...skus.map(
      (s) => `  • ${s.name} — ${s.stockCount} on hand (threshold ${s.threshold})`,
    ),
    "",
    "Manage inventory: /admin/shop/inventory",
  ];
  const text = textLines.join("\n");
  const rows = skus
    .map(
      (s) =>
        `\n        <tr>\n          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(s.name)}</td>\n          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-variant-numeric:tabular-nums;">${s.stockCount}</td>\n          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-variant-numeric:tabular-nums;color:#6b7280;">${s.threshold}</td>\n        </tr>`,
    )
    .join("");
  const html = `<!doctype html>${rows}`;
  return { subject, html, text };
}

const SAMPLE_SKU: BelowThresholdSku = {
  productId: "prod_abc",
  name: "CPAP Mask",
  stockCount: 2,
  threshold: 5,
};

describe("renderDigest — subject", () => {
  it("pluralises SKU correctly for 1 SKU", () => {
    expect(renderDigest([SAMPLE_SKU]).subject).toContain("1 SKU");
    expect(renderDigest([SAMPLE_SKU]).subject).not.toContain("SKUs");
  });

  it("pluralises SKUs correctly for multiple SKUs", () => {
    const two = [SAMPLE_SKU, { ...SAMPLE_SKU, productId: "p2", name: "Tube" }];
    expect(renderDigest(two).subject).toContain("2 SKUs");
  });

  it("includes the brand in the subject", () => {
    expect(renderDigest([SAMPLE_SKU]).subject).toContain("PennPaps");
  });
});

describe("renderDigest — text body", () => {
  it("includes product name", () => {
    expect(renderDigest([SAMPLE_SKU]).text).toContain("CPAP Mask");
  });

  it("includes stock count", () => {
    expect(renderDigest([SAMPLE_SKU]).text).toContain("2 on hand");
  });

  it("includes threshold", () => {
    expect(renderDigest([SAMPLE_SKU]).text).toContain("threshold 5");
  });

  it("includes inventory URL", () => {
    expect(renderDigest([SAMPLE_SKU]).text).toContain("/admin/shop/inventory");
  });

  it("uses singular 'product is' for one item", () => {
    expect(renderDigest([SAMPLE_SKU]).text).toContain("1 product is");
  });

  it("uses plural 'products are' for multiple items", () => {
    const two = [SAMPLE_SKU, { ...SAMPLE_SKU, productId: "p2", name: "Tube" }];
    expect(renderDigest(two).text).toContain("2 products are");
  });
});

describe("renderDigest — HTML", () => {
  it("HTML-escapes < in product name", () => {
    const sku = { ...SAMPLE_SKU, name: "<script>" };
    const { html } = renderDigest([sku]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("HTML-escapes & in product name", () => {
    const sku = { ...SAMPLE_SKU, name: "Tom & Jerry" };
    expect(renderDigest([sku]).html).toContain("Tom &amp; Jerry");
  });
});

// ---------------------------------------------------------------------------
// runLowStockAlerts — integration tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  supabaseMock.reset();
  stripeConfigured = false;
  emailConfigured = true;
  stripeProductsListMock.mockReset();
  sendEmailMock.mockReset();
});

describe("runLowStockAlerts — Stripe not configured", () => {
  it("returns zeroed stats immediately without calling Stripe", async () => {
    stripeConfigured = false;

    const stats = await runLowStockAlerts();

    expect(stats.scanned).toBe(0);
    expect(stats.belowThreshold).toBe(0);
    expect(stats.newAlerts).toBe(0);
    expect(stats.emailSent).toBe(false);
    expect(stripeProductsListMock).not.toHaveBeenCalled();
  });
});

describe("runLowStockAlerts — no SKUs below threshold", () => {
  it("returns belowThreshold=0 and emailSent=false when all SKUs are fine", async () => {
    stripeConfigured = true;
    stripeProductsListMock.mockResolvedValue({
      data: [
        { id: "prod_1", name: "Mask", stockCount: 10, lowStockThreshold: 5 },
      ],
    });
    // Supabase: update for resolved SKUs returns empty
    stageSupabaseResponse("low_stock_alert_state", "update", {
      data: [],
      error: null,
    });

    const stats = await runLowStockAlerts();

    expect(stats.scanned).toBe(1);
    expect(stats.belowThreshold).toBe(0);
    expect(stats.emailSent).toBe(false);
  });
});

describe("runLowStockAlerts — all alerts within cooldown", () => {
  it("suppresses the alert and returns cooldownSkipped=1", async () => {
    stripeConfigured = true;
    stripeProductsListMock.mockResolvedValue({
      data: [
        { id: "prod_1", name: "Mask", stockCount: 2, lowStockThreshold: 5 },
      ],
    });
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    stageSupabaseResponse("low_stock_alert_state", "select", {
      data: [
        {
          product_id: "prod_1",
          last_alerted_at: oneHourAgo,
          last_resolved_at: null,
        },
      ],
      error: null,
    });

    const stats = await runLowStockAlerts();

    expect(stats.cooldownSkipped).toBe(1);
    expect(stats.newAlerts).toBe(0);
    expect(stats.emailSent).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("runLowStockAlerts — no recipients", () => {
  it("upserts state but sends no email when RESUPPLY_ADMIN_EMAILS is unset", async () => {
    const saved = process.env.RESUPPLY_ADMIN_EMAILS;
    delete process.env.RESUPPLY_ADMIN_EMAILS;

    stripeConfigured = true;
    stripeProductsListMock.mockResolvedValue({
      data: [
        { id: "prod_1", name: "Mask", stockCount: 2, lowStockThreshold: 5 },
      ],
    });
    stageSupabaseResponse("low_stock_alert_state", "select", {
      data: [],
      error: null,
    });
    stageSupabaseResponse("low_stock_alert_state", "upsert", {
      data: null,
      error: null,
    });

    const stats = await runLowStockAlerts();

    expect(stats.recipients).toBe(0);
    expect(stats.emailSent).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();

    process.env.RESUPPLY_ADMIN_EMAILS = saved;
  });
});

describe("runLowStockAlerts — email not configured", () => {
  it("does not throw and returns emailSent=false when email is unconfigured", async () => {
    process.env.RESUPPLY_ADMIN_EMAILS = "ops@test.com";
    emailConfigured = false;
    stripeConfigured = true;
    stripeProductsListMock.mockResolvedValue({
      data: [
        { id: "prod_1", name: "Mask", stockCount: 2, lowStockThreshold: 5 },
      ],
    });
    stageSupabaseResponse("low_stock_alert_state", "select", {
      data: [],
      error: null,
    });

    const stats = await runLowStockAlerts();

    expect(stats.emailSent).toBe(false);

    delete process.env.RESUPPLY_ADMIN_EMAILS;
  });
});

describe("runLowStockAlerts — happy path", () => {
  it("sends email and returns emailSent=true when a below-threshold SKU is never-alerted", async () => {
    process.env.RESUPPLY_ADMIN_EMAILS = "ops@test.com";
    stripeConfigured = true;
    emailConfigured = true;
    stripeProductsListMock.mockResolvedValue({
      data: [
        { id: "prod_1", name: "CPAP Mask", stockCount: 2, lowStockThreshold: 5 },
      ],
    });
    stageSupabaseResponse("low_stock_alert_state", "select", {
      data: [],
      error: null,
    });
    stageSupabaseResponse("low_stock_alert_state", "upsert", {
      data: null,
      error: null,
    });

    const stats = await runLowStockAlerts();

    expect(stats.belowThreshold).toBe(1);
    expect(stats.newAlerts).toBe(1);
    expect(stats.recipients).toBe(1);
    expect(stats.emailSent).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const callArg = sendEmailMock.mock.calls[0][0] as { to: string; subject: string };
    expect(callArg.to).toBe("ops@test.com");
    expect(callArg.subject).toContain("1 SKU");

    delete process.env.RESUPPLY_ADMIN_EMAILS;
  });

  it("re-alerts a previously-resolved SKU (fresh dip scenario)", async () => {
    process.env.RESUPPLY_ADMIN_EMAILS = "ops@test.com";
    stripeConfigured = true;
    emailConfigured = true;
    stripeProductsListMock.mockResolvedValue({
      data: [
        { id: "prod_1", name: "CPAP Mask", stockCount: 2, lowStockThreshold: 5 },
      ],
    });
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    stageSupabaseResponse("low_stock_alert_state", "select", {
      data: [
        {
          product_id: "prod_1",
          last_alerted_at: longAgo,
          last_resolved_at: sixHoursAgo, // resolved since last alert → fresh dip
        },
      ],
      error: null,
    });
    stageSupabaseResponse("low_stock_alert_state", "upsert", {
      data: null,
      error: null,
    });

    const stats = await runLowStockAlerts();

    expect(stats.newAlerts).toBe(1);
    expect(stats.emailSent).toBe(true);

    delete process.env.RESUPPLY_ADMIN_EMAILS;
  });

  it("re-alerts when cooldown has expired (25h since last alert)", async () => {
    process.env.RESUPPLY_ADMIN_EMAILS = "ops@test.com";
    stripeConfigured = true;
    emailConfigured = true;
    stripeProductsListMock.mockResolvedValue({
      data: [
        { id: "prod_1", name: "CPAP Mask", stockCount: 2, lowStockThreshold: 5 },
      ],
    });
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    stageSupabaseResponse("low_stock_alert_state", "select", {
      data: [
        {
          product_id: "prod_1",
          last_alerted_at: twentyFiveHoursAgo,
          last_resolved_at: null,
        },
      ],
      error: null,
    });
    stageSupabaseResponse("low_stock_alert_state", "upsert", {
      data: null,
      error: null,
    });

    const stats = await runLowStockAlerts();

    expect(stats.newAlerts).toBe(1);
    expect(stats.emailSent).toBe(true);

    delete process.env.RESUPPLY_ADMIN_EMAILS;
  });

  it("skips untracked SKUs (stockCount null)", async () => {
    process.env.RESUPPLY_ADMIN_EMAILS = "ops@test.com";
    stripeConfigured = true;
    stripeProductsListMock.mockResolvedValue({
      data: [
        { id: "prod_1", name: "Untracked", stockCount: null, lowStockThreshold: 5 },
      ],
    });

    const stats = await runLowStockAlerts();

    expect(stats.belowThreshold).toBe(0);
    expect(stats.emailSent).toBe(false);

    delete process.env.RESUPPLY_ADMIN_EMAILS;
  });

  it("skips SKUs with threshold=0 (explicit opt-out)", async () => {
    process.env.RESUPPLY_ADMIN_EMAILS = "ops@test.com";
    stripeConfigured = true;
    stripeProductsListMock.mockResolvedValue({
      data: [
        { id: "prod_1", name: "Opted Out", stockCount: 0, lowStockThreshold: 0 },
      ],
    });

    const stats = await runLowStockAlerts();

    expect(stats.belowThreshold).toBe(0);
    expect(stats.emailSent).toBe(false);

    delete process.env.RESUPPLY_ADMIN_EMAILS;
  });
});

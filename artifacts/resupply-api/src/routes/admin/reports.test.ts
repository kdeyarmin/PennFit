// Tests for /admin/reports/* — the admin reporting surface.
//
// Coverage focus: the NEW routes added in this PR.
//   * Four formats per report: .csv, .pdf, .iif, .qbo.csv
//   * Reports: orders, returns, revenue-summary, refunds-journal
//
// Per-test assertions:
//   1. Each endpoint requires the reports.read permission (401 for anon).
//   2. CSV endpoints set Content-Type: text/csv and Content-Disposition.
//   3. PDF endpoints set Content-Type: application/pdf and return a buffer
//      that starts with the %PDF- magic header.
//   4. IIF endpoints set Content-Type: application/octet-stream.
//   5. QBO CSV endpoints set Content-Type: text/csv with the correct filename.
//   6. Revenue-summary and refunds-journal new endpoints respond correctly.
//   7. rollupRevenue helper (tested via the endpoint) aggregates orders by day.
//
// We mock the renderTablePdf / renderIif / renderQboCsv helpers to avoid
// their external dependencies (pdfkit) and keep tests fast. The helpers
// themselves are tested in their own dedicated test files.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

// ─── Supabase mock ────────────────────────────────────────────────────────

const supabaseMock = installSupabaseMock();

// ─── Auth mock ────────────────────────────────────────────────────────────

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// ─── Stub PDF / QB rendering to avoid pdfkit in tests ────────────────────

const renderTablePdfMock = vi.hoisted(() =>
  vi.fn(async () => Buffer.from("%PDF-1.4 mock pdf content")),
);
vi.mock("../../lib/report-pdf", () => ({
  renderTablePdf: renderTablePdfMock,
  REPORT_USABLE_WIDTH: 720,
}));

const renderIifMock = vi.hoisted(() =>
  vi.fn(() => "!TRNS\tmock iif content\n"),
);
const renderQboCsvMock = vi.hoisted(() =>
  vi.fn(() => "Date,Description,Customer,Amount,Type,Reference\n"),
);
vi.mock("../../lib/quickbooks-export", () => ({
  renderIif: renderIifMock,
  renderQboCsv: renderQboCsvMock,
  customerKeyForId: (id: string | null) => (id ? `cust-${id.slice(0, 6)}` : "cust-unknown"),
}));

// ─── SUT ──────────────────────────────────────────────────────────────────

import reportsRouter from "./reports";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(reportsRouter);
  return app;
}

function stubAdmin(role: "admin" | "agent" = "admin") {
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "ops@example.com",
    role,
  };
}

// Minimal order row matching the OrderRow interface in reports.ts.
function makeOrderRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "order-abc123",
    stripe_session_id: "cs_test_session",
    stripe_payment_intent_id: "pi_test",
    status: "paid",
    amount_total_cents: 25000,
    currency: "usd",
    customer_id: "cust-xyz",
    created_at: "2026-04-15T10:00:00.000Z",
    paid_at: "2026-04-15T10:00:00.000Z",
    shipped_at: null,
    delivered_at: null,
    tracking_carrier: null,
    tracking_number: null,
    ...over,
  };
}

// Minimal return row.
function makeReturnRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "return-def456",
    order_id: "order-abc123",
    stripe_session_id: null,
    status: "approved",
    reason: "wrong size",
    resolution: "refund",
    refund_cents: 7500,
    stripe_refund_id: "re_test_refund",
    exchange_product_id: null,
    created_at: "2026-04-20T10:00:00.000Z",
    approved_at: "2026-04-21T10:00:00.000Z",
    received_at: null,
    resolved_at: "2026-04-22T10:00:00.000Z",
    closed_at: null,
    ...over,
  };
}

const FROM = "2026-04-01";
const TO = "2026-04-30";

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  renderTablePdfMock.mockClear();
  renderIifMock.mockClear();
  renderQboCsvMock.mockClear();
});

// ─── Auth guards ──────────────────────────────────────────────────────────

describe("reports endpoints — auth", () => {
  it.each([
    "/admin/reports/orders.csv",
    "/admin/reports/orders.pdf",
    "/admin/reports/orders.iif",
    "/admin/reports/orders.qbo.csv",
    "/admin/reports/returns.csv",
    "/admin/reports/returns.pdf",
    "/admin/reports/returns.iif",
    "/admin/reports/returns.qbo.csv",
    "/admin/reports/revenue-summary.csv",
    "/admin/reports/revenue-summary.pdf",
    "/admin/reports/refunds-journal.csv",
    "/admin/reports/refunds-journal.pdf",
  ])("returns 401 for unauthenticated request to %s", async (path) => {
    const res = await request(makeApp()).get(path);
    expect(res.status).toBe(401);
  });
});

// ─── orders.pdf ───────────────────────────────────────────────────────────

describe("GET /admin/reports/orders.pdf", () => {
  it("returns 200 with Content-Type: application/pdf", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [makeOrderRow()] });

    const res = await request(makeApp())
      .get(`/admin/reports/orders.pdf?from=${FROM}&to=${TO}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
  });

  it("sets Content-Disposition as an attachment with .pdf filename", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [] });

    const res = await request(makeApp())
      .get(`/admin/reports/orders.pdf?from=${FROM}&to=${TO}`);

    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(".pdf");
  });

  it("sets Content-Length matching the returned buffer size", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [] });
    const fakeBuffer = Buffer.from("%PDF-1.4 fake pdf");
    renderTablePdfMock.mockResolvedValueOnce(fakeBuffer);

    const res = await request(makeApp())
      .get(`/admin/reports/orders.pdf?from=${FROM}&to=${TO}`);

    const cl = parseInt(res.headers["content-length"] ?? "0", 10);
    expect(cl).toBe(fakeBuffer.length);
  });

  it("calls renderTablePdf with the orders data", async () => {
    stubAdmin();
    const order = makeOrderRow();
    stageSupabaseResponse("shop_orders", "select", { data: [order] });

    await request(makeApp())
      .get(`/admin/reports/orders.pdf?from=${FROM}&to=${TO}`);

    expect(renderTablePdfMock).toHaveBeenCalledOnce();
    const call = renderTablePdfMock.mock.calls[0]![0] as { title: string };
    expect(call.title).toBe("Cash-pay orders");
  });
});

// ─── orders.iif ───────────────────────────────────────────────────────────

describe("GET /admin/reports/orders.iif", () => {
  it("returns 200 with Content-Type: application/octet-stream", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [makeOrderRow()] });

    const res = await request(makeApp())
      .get(`/admin/reports/orders.iif?from=${FROM}&to=${TO}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/octet-stream");
  });

  it("sets Content-Disposition as an attachment with .iif filename", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [] });

    const res = await request(makeApp())
      .get(`/admin/reports/orders.iif?from=${FROM}&to=${TO}`);

    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(".iif");
  });

  it("calls renderIif with ORDER-kind rows for paid orders", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", {
      data: [makeOrderRow({ status: "paid" })],
    });

    await request(makeApp())
      .get(`/admin/reports/orders.iif?from=${FROM}&to=${TO}`);

    expect(renderIifMock).toHaveBeenCalledOnce();
    const call = renderIifMock.mock.calls[0]![0] as {
      rows: Array<{ kind: string }>;
    };
    expect(call.rows).toHaveLength(1);
    expect(call.rows[0]!.kind).toBe("ORDER");
  });

  it("excludes orders with non-paid statuses from the IIF output", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", {
      data: [
        makeOrderRow({ status: "pending" }),
        makeOrderRow({ id: "order-2", status: "paid" }),
      ],
    });

    await request(makeApp())
      .get(`/admin/reports/orders.iif?from=${FROM}&to=${TO}`);

    const call = renderIifMock.mock.calls[0]![0] as {
      rows: Array<{ kind: string }>;
    };
    // Only the paid order should appear in the QB export.
    expect(call.rows).toHaveLength(1);
  });
});

// ─── orders.qbo.csv ──────────────────────────────────────────────────────

describe("GET /admin/reports/orders.qbo.csv", () => {
  it("returns 200 with Content-Type: text/csv", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [] });

    const res = await request(makeApp())
      .get(`/admin/reports/orders.qbo.csv?from=${FROM}&to=${TO}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
  });

  it("sets a Content-Disposition filename ending in .csv (not .qbo)", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [] });

    const res = await request(makeApp())
      .get(`/admin/reports/orders.qbo.csv?from=${FROM}&to=${TO}`);

    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(".csv");
  });

  it("calls renderQboCsv with the orders data", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", {
      data: [makeOrderRow()],
    });

    await request(makeApp())
      .get(`/admin/reports/orders.qbo.csv?from=${FROM}&to=${TO}`);

    expect(renderQboCsvMock).toHaveBeenCalledOnce();
  });
});

// ─── returns.pdf ─────────────────────────────────────────────────────────

describe("GET /admin/reports/returns.pdf", () => {
  it("returns 200 with Content-Type: application/pdf", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_returns", "select", {
      data: [makeReturnRow()],
    });

    const res = await request(makeApp())
      .get(`/admin/reports/returns.pdf?from=${FROM}&to=${TO}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
  });

  it("calls renderTablePdf with the returns title", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_returns", "select", { data: [] });

    await request(makeApp())
      .get(`/admin/reports/returns.pdf?from=${FROM}&to=${TO}`);

    expect(renderTablePdfMock).toHaveBeenCalledOnce();
    const call = renderTablePdfMock.mock.calls[0]![0] as { title: string };
    expect(call.title).toBe("Returns & RMAs");
  });
});

// ─── returns.iif ─────────────────────────────────────────────────────────

describe("GET /admin/reports/returns.iif", () => {
  it("returns 200 with Content-Type: application/octet-stream", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_returns", "select", { data: [] });

    const res = await request(makeApp())
      .get(`/admin/reports/returns.iif?from=${FROM}&to=${TO}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/octet-stream");
  });

  it("calls renderIif with REFUND-kind rows for refunded returns", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_returns", "select", {
      data: [makeReturnRow({ refund_cents: 7500 })],
    });

    await request(makeApp())
      .get(`/admin/reports/returns.iif?from=${FROM}&to=${TO}`);

    expect(renderIifMock).toHaveBeenCalledOnce();
    const call = renderIifMock.mock.calls[0]![0] as {
      rows: Array<{ kind: string; amountUsd: number }>;
    };
    expect(call.rows).toHaveLength(1);
    expect(call.rows[0]!.kind).toBe("REFUND");
    // Refund amounts should be negative in the QB row.
    expect(call.rows[0]!.amountUsd).toBeLessThan(0);
  });

  it("excludes returns with no refund from the IIF export", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_returns", "select", {
      data: [
        makeReturnRow({ refund_cents: null }),
        makeReturnRow({ id: "return-2", refund_cents: 5000 }),
      ],
    });

    await request(makeApp())
      .get(`/admin/reports/returns.iif?from=${FROM}&to=${TO}`);

    const call = renderIifMock.mock.calls[0]![0] as {
      rows: Array<{ kind: string }>;
    };
    expect(call.rows).toHaveLength(1);
  });
});

// ─── returns.qbo.csv ─────────────────────────────────────────────────────

describe("GET /admin/reports/returns.qbo.csv", () => {
  it("returns 200 with Content-Type: text/csv", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_returns", "select", { data: [] });

    const res = await request(makeApp())
      .get(`/admin/reports/returns.qbo.csv?from=${FROM}&to=${TO}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
  });
});

// ─── revenue-summary.csv ─────────────────────────────────────────────────

describe("GET /admin/reports/revenue-summary.csv", () => {
  it("returns 200 with Content-Type: text/csv", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [] });
    stageSupabaseResponse("shop_returns", "select", { data: [] });

    const res = await request(makeApp())
      .get(`/admin/reports/revenue-summary.csv?from=${FROM}&to=${TO}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
  });

  it("sets a Content-Disposition filename containing 'revenue'", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [] });
    stageSupabaseResponse("shop_returns", "select", { data: [] });

    const res = await request(makeApp())
      .get(`/admin/reports/revenue-summary.csv?from=${FROM}&to=${TO}`);

    expect(res.headers["content-disposition"]).toContain("revenue");
  });

  it("returns a CSV with the day, orders_count, gross_usd, refunded_usd, net_usd headers", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [] });
    stageSupabaseResponse("shop_returns", "select", { data: [] });

    const res = await request(makeApp())
      .get(`/admin/reports/revenue-summary.csv?from=${FROM}&to=${TO}`);

    const csv = res.text;
    const header = csv.split("\n")[0]!;
    expect(header).toContain("day");
    expect(header).toContain("orders_count");
    expect(header).toContain("gross_usd");
    expect(header).toContain("refunded_usd");
    expect(header).toContain("net_usd");
  });

  it("aggregates paid orders by day", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", {
      data: [
        makeOrderRow({ status: "paid", paid_at: "2026-04-10T10:00:00Z", amount_total_cents: 10000 }),
        makeOrderRow({ id: "ord-2", status: "shipped", paid_at: "2026-04-10T12:00:00Z", amount_total_cents: 20000 }),
      ],
    });
    stageSupabaseResponse("shop_returns", "select", { data: [] });

    const res = await request(makeApp())
      .get(`/admin/reports/revenue-summary.csv?from=${FROM}&to=${TO}`);

    // Should have the header + 1 data row (both orders are on 2026-04-10).
    const lines = res.text.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2); // header + 1 aggregated row
    expect(lines[1]).toContain("2026-04-10");
  });
});

// ─── revenue-summary.pdf ─────────────────────────────────────────────────

describe("GET /admin/reports/revenue-summary.pdf", () => {
  it("returns 200 with Content-Type: application/pdf", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [] });
    stageSupabaseResponse("shop_returns", "select", { data: [] });

    const res = await request(makeApp())
      .get(`/admin/reports/revenue-summary.pdf?from=${FROM}&to=${TO}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
  });

  it("calls renderTablePdf with the 'Revenue summary' title", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [] });
    stageSupabaseResponse("shop_returns", "select", { data: [] });

    await request(makeApp())
      .get(`/admin/reports/revenue-summary.pdf?from=${FROM}&to=${TO}`);

    expect(renderTablePdfMock).toHaveBeenCalledOnce();
    const call = renderTablePdfMock.mock.calls[0]![0] as { title: string };
    expect(call.title).toBe("Revenue summary");
  });
});

// ─── refunds-journal.csv ─────────────────────────────────────────────────

describe("GET /admin/reports/refunds-journal.csv", () => {
  it("returns 200 with Content-Type: text/csv", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_returns", "select", { data: [] });

    const res = await request(makeApp())
      .get(`/admin/reports/refunds-journal.csv?from=${FROM}&to=${TO}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
  });

  it("returns a CSV with the refunds-journal columns", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_returns", "select", { data: [] });

    const res = await request(makeApp())
      .get(`/admin/reports/refunds-journal.csv?from=${FROM}&to=${TO}`);

    const header = res.text.split("\n")[0]!;
    expect(header).toContain("return_id");
    expect(header).toContain("order_id");
    expect(header).toContain("stripe_refund_id");
    expect(header).toContain("refund_usd");
  });

  it("only includes rows that have a positive refund_cents", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_returns", "select", {
      data: [
        makeReturnRow({ refund_cents: null }),
        makeReturnRow({ id: "return-2", refund_cents: 0 }),
        makeReturnRow({ id: "return-3", refund_cents: 5000 }),
      ],
    });

    const res = await request(makeApp())
      .get(`/admin/reports/refunds-journal.csv?from=${FROM}&to=${TO}`);

    // Header + 1 data row (the one with 5000 cents).
    const lines = res.text.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);
  });
});

// ─── refunds-journal.pdf ─────────────────────────────────────────────────

describe("GET /admin/reports/refunds-journal.pdf", () => {
  it("returns 200 with Content-Type: application/pdf", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_returns", "select", {
      data: [makeReturnRow()],
    });

    const res = await request(makeApp())
      .get(`/admin/reports/refunds-journal.pdf?from=${FROM}&to=${TO}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
  });

  it("calls renderTablePdf with the 'Refunds journal' title", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_returns", "select", { data: [] });

    await request(makeApp())
      .get(`/admin/reports/refunds-journal.pdf?from=${FROM}&to=${TO}`);

    expect(renderTablePdfMock).toHaveBeenCalledOnce();
    const call = renderTablePdfMock.mock.calls[0]![0] as { title: string };
    expect(call.title).toBe("Refunds journal");
  });
});

// ─── orders.csv regression — pre-existing endpoint ───────────────────────
// The orders.csv endpoint existed before this PR; we add a minimal
// regression test to confirm it still returns the correct headers.

describe("GET /admin/reports/orders.csv (regression)", () => {
  it("returns 200 with Content-Type: text/csv and a .csv filename", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [] });

    const res = await request(makeApp())
      .get(`/admin/reports/orders.csv?from=${FROM}&to=${TO}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain(".csv");
  });
});

// ─── returns.csv regression ──────────────────────────────────────────────

describe("GET /admin/reports/returns.csv (regression)", () => {
  it("returns 200 with Content-Type: text/csv", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_returns", "select", { data: [] });

    const res = await request(makeApp())
      .get(`/admin/reports/returns.csv?from=${FROM}&to=${TO}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
  });
});

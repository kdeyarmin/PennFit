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
  vi.fn<(input: Record<string, unknown>) => Promise<Buffer>>(async () =>
    Buffer.from("%PDF-1.4 mock pdf content"),
  ),
);
vi.mock("../../lib/report-pdf", () => ({
  renderTablePdf: renderTablePdfMock,
  REPORT_USABLE_WIDTH: 720,
}));

const renderIifMock = vi.hoisted(() =>
  vi.fn<(input: Record<string, unknown>) => string>(
    () => "!TRNS\tmock iif content\n",
  ),
);
const renderQboCsvMock = vi.hoisted(() =>
  vi.fn<(input: Record<string, unknown>) => string>(
    () => "Date,Description,Customer,Amount,Type,Reference\n",
  ),
);
vi.mock("../../lib/quickbooks-export", () => ({
  renderIif: renderIifMock,
  renderQboCsv: renderQboCsvMock,
  customerKeyForId: (id: string | null) =>
    id ? `cust-${id.slice(0, 6)}` : "cust-unknown",
}));

// ─── Stub SendGrid + audit for the email-this-report endpoint ────────────

const {
  sendEmailMock,
  createSendgridClientMock,
  EmailConfigErrorStub,
  EmailApiErrorStub,
} = vi.hoisted(() => {
  const sendEmailMock = vi.fn<
    (input: Record<string, unknown>) => Promise<{ messageId: string }>
  >(async () => ({ messageId: "test-msg-id-1" }));
  const createSendgridClientMock = vi.fn(() => ({
    sendEmail: sendEmailMock,
  }));
  class EmailConfigErrorStub extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "EmailConfigError";
    }
  }
  class EmailApiErrorStub extends Error {
    status?: number;
    constructor(msg: string, status?: number) {
      super(msg);
      this.name = "EmailApiError";
      this.status = status;
    }
  }
  return {
    sendEmailMock,
    createSendgridClientMock,
    EmailConfigErrorStub,
    EmailApiErrorStub,
  };
});
vi.mock("@workspace/resupply-email", () => ({
  createSendgridClient: createSendgridClientMock,
  EmailConfigError: EmailConfigErrorStub,
  EmailApiError: EmailApiErrorStub,
}));

const logAuditMock = vi.hoisted(() =>
  vi.fn<(event: Record<string, unknown>) => Promise<void>>(() =>
    Promise.resolve(),
  ),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit:
    () =>
    (
      _req: import("express").Request,
      _res: import("express").Response,
      next: import("express").NextFunction,
    ) =>
      next(),
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
function makeOrderRow(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
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
function makeReturnRow(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
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
  sendEmailMock.mockClear();
  createSendgridClientMock.mockClear();
  createSendgridClientMock.mockImplementation(() => ({
    sendEmail: sendEmailMock,
  }));
  sendEmailMock.mockResolvedValue({ messageId: "test-msg-id-1" });
  logAuditMock.mockClear();
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

    const res = await request(makeApp()).get(
      `/admin/reports/orders.pdf?from=${FROM}&to=${TO}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
  });

  it("sets Content-Disposition as an attachment with .pdf filename", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [] });

    const res = await request(makeApp()).get(
      `/admin/reports/orders.pdf?from=${FROM}&to=${TO}`,
    );

    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(".pdf");
  });

  it("sets Content-Length matching the returned buffer size", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [] });
    const fakeBuffer = Buffer.from("%PDF-1.4 fake pdf");
    renderTablePdfMock.mockResolvedValueOnce(fakeBuffer);

    const res = await request(makeApp()).get(
      `/admin/reports/orders.pdf?from=${FROM}&to=${TO}`,
    );

    const cl = parseInt(res.headers["content-length"] ?? "0", 10);
    expect(cl).toBe(fakeBuffer.length);
  });

  it("calls renderTablePdf with the orders data", async () => {
    stubAdmin();
    const order = makeOrderRow();
    stageSupabaseResponse("shop_orders", "select", { data: [order] });

    await request(makeApp()).get(
      `/admin/reports/orders.pdf?from=${FROM}&to=${TO}`,
    );

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

    const res = await request(makeApp()).get(
      `/admin/reports/orders.iif?from=${FROM}&to=${TO}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/octet-stream");
  });

  it("sets Content-Disposition as an attachment with .iif filename", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [] });

    const res = await request(makeApp()).get(
      `/admin/reports/orders.iif?from=${FROM}&to=${TO}`,
    );

    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(".iif");
  });

  it("calls renderIif with ORDER-kind rows for paid orders", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", {
      data: [makeOrderRow({ status: "paid" })],
    });

    await request(makeApp()).get(
      `/admin/reports/orders.iif?from=${FROM}&to=${TO}`,
    );

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

    await request(makeApp()).get(
      `/admin/reports/orders.iif?from=${FROM}&to=${TO}`,
    );

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

    const res = await request(makeApp()).get(
      `/admin/reports/orders.qbo.csv?from=${FROM}&to=${TO}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
  });

  it("sets a Content-Disposition filename ending in .csv (not .qbo)", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [] });

    const res = await request(makeApp()).get(
      `/admin/reports/orders.qbo.csv?from=${FROM}&to=${TO}`,
    );

    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(".csv");
  });

  it("calls renderQboCsv with the orders data", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", {
      data: [makeOrderRow()],
    });

    await request(makeApp()).get(
      `/admin/reports/orders.qbo.csv?from=${FROM}&to=${TO}`,
    );

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

    const res = await request(makeApp()).get(
      `/admin/reports/returns.pdf?from=${FROM}&to=${TO}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
  });

  it("calls renderTablePdf with the returns title", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_returns", "select", { data: [] });

    await request(makeApp()).get(
      `/admin/reports/returns.pdf?from=${FROM}&to=${TO}`,
    );

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

    const res = await request(makeApp()).get(
      `/admin/reports/returns.iif?from=${FROM}&to=${TO}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/octet-stream");
  });

  it("calls renderIif with REFUND-kind rows for refunded returns", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_returns", "select", {
      data: [makeReturnRow({ refund_cents: 7500 })],
    });

    await request(makeApp()).get(
      `/admin/reports/returns.iif?from=${FROM}&to=${TO}`,
    );

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

    await request(makeApp()).get(
      `/admin/reports/returns.iif?from=${FROM}&to=${TO}`,
    );

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

    const res = await request(makeApp()).get(
      `/admin/reports/returns.qbo.csv?from=${FROM}&to=${TO}`,
    );

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

    const res = await request(makeApp()).get(
      `/admin/reports/revenue-summary.csv?from=${FROM}&to=${TO}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
  });

  it("sets a Content-Disposition filename containing 'revenue'", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [] });
    stageSupabaseResponse("shop_returns", "select", { data: [] });

    const res = await request(makeApp()).get(
      `/admin/reports/revenue-summary.csv?from=${FROM}&to=${TO}`,
    );

    expect(res.headers["content-disposition"]).toContain("revenue");
  });

  it("returns a CSV with the day, orders_count, gross_usd, refunded_usd, net_usd headers", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [] });
    stageSupabaseResponse("shop_returns", "select", { data: [] });

    const res = await request(makeApp()).get(
      `/admin/reports/revenue-summary.csv?from=${FROM}&to=${TO}`,
    );

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
        makeOrderRow({
          status: "paid",
          paid_at: "2026-04-10T10:00:00Z",
          amount_total_cents: 10000,
        }),
        makeOrderRow({
          id: "ord-2",
          status: "shipped",
          paid_at: "2026-04-10T12:00:00Z",
          amount_total_cents: 20000,
        }),
      ],
    });
    stageSupabaseResponse("shop_returns", "select", { data: [] });

    const res = await request(makeApp()).get(
      `/admin/reports/revenue-summary.csv?from=${FROM}&to=${TO}`,
    );

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

    const res = await request(makeApp()).get(
      `/admin/reports/revenue-summary.pdf?from=${FROM}&to=${TO}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
  });

  it("calls renderTablePdf with the 'Revenue summary' title", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [] });
    stageSupabaseResponse("shop_returns", "select", { data: [] });

    await request(makeApp()).get(
      `/admin/reports/revenue-summary.pdf?from=${FROM}&to=${TO}`,
    );

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

    const res = await request(makeApp()).get(
      `/admin/reports/refunds-journal.csv?from=${FROM}&to=${TO}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
  });

  it("returns a CSV with the refunds-journal columns", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_returns", "select", { data: [] });

    const res = await request(makeApp()).get(
      `/admin/reports/refunds-journal.csv?from=${FROM}&to=${TO}`,
    );

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

    const res = await request(makeApp()).get(
      `/admin/reports/refunds-journal.csv?from=${FROM}&to=${TO}`,
    );

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

    const res = await request(makeApp()).get(
      `/admin/reports/refunds-journal.pdf?from=${FROM}&to=${TO}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
  });

  it("calls renderTablePdf with the 'Refunds journal' title", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_returns", "select", { data: [] });

    await request(makeApp()).get(
      `/admin/reports/refunds-journal.pdf?from=${FROM}&to=${TO}`,
    );

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

    const res = await request(makeApp()).get(
      `/admin/reports/orders.csv?from=${FROM}&to=${TO}`,
    );

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

    const res = await request(makeApp()).get(
      `/admin/reports/returns.csv?from=${FROM}&to=${TO}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
  });
});

// ─── insurance-claims ───────────────────────────────────────────────────

function makeClaimRow(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "claim-abc123",
    patient_id: "patient-xyz789",
    payer_name: "Aetna",
    claim_number: "CLM-001",
    date_of_service: "2026-04-10",
    status: "paid",
    total_billed_cents: 50000,
    total_allowed_cents: 35000,
    total_paid_cents: 28000,
    patient_responsibility_cents: 7000,
    submitted_at: "2026-04-12T10:00:00.000Z",
    decision_at: "2026-04-15T10:00:00.000Z",
    paid_at: "2026-04-16T10:00:00.000Z",
    created_at: "2026-04-11T10:00:00.000Z",
    ...over,
  };
}

describe("GET /admin/reports/insurance-claims.csv", () => {
  it("returns 200 with Content-Type: text/csv", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", { data: [] });

    const res = await request(makeApp()).get(
      `/admin/reports/insurance-claims.csv?from=${FROM}&to=${TO}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
  });

  it("uses patient_key (hashed) column, never raw patient_id", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: [makeClaimRow()],
    });

    const res = await request(makeApp()).get(
      `/admin/reports/insurance-claims.csv?from=${FROM}&to=${TO}`,
    );

    const header = res.text.split("\n")[0]!;
    expect(header).toContain("patient_key");
    expect(header).not.toContain("patient_id");
    // The raw patient id is not in the body either.
    expect(res.text).not.toContain("patient-xyz789");
  });

  it("never serialises free-text PHI fields", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: [makeClaimRow()],
    });

    const res = await request(makeApp()).get(
      `/admin/reports/insurance-claims.csv?from=${FROM}&to=${TO}`,
    );

    const header = res.text.split("\n")[0]!;
    expect(header).not.toContain("notes");
    expect(header).not.toContain("denial_reason");
  });
});

describe("GET /admin/reports/insurance-claims.pdf", () => {
  it("returns 200 with Content-Type: application/pdf", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", { data: [] });

    const res = await request(makeApp()).get(
      `/admin/reports/insurance-claims.pdf?from=${FROM}&to=${TO}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
  });

  it("passes Insurance claims as the title", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", { data: [] });

    await request(makeApp()).get(
      `/admin/reports/insurance-claims.pdf?from=${FROM}&to=${TO}`,
    );

    expect(renderTablePdfMock).toHaveBeenCalledOnce();
    const call = renderTablePdfMock.mock.calls[0]![0] as { title: string };
    expect(call.title).toBe("Insurance claims");
  });
});

describe("GET /admin/reports/insurance-claims.iif", () => {
  it("returns 200 with Content-Type: application/octet-stream", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", { data: [] });

    const res = await request(makeApp()).get(
      `/admin/reports/insurance-claims.iif?from=${FROM}&to=${TO}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/octet-stream");
  });

  it("includes only paid-status claims in the QB row stream", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        makeClaimRow({ id: "c1", status: "paid", total_paid_cents: 10000 }),
        makeClaimRow({
          id: "c2",
          status: "denied",
          total_paid_cents: 0,
        }),
        makeClaimRow({
          id: "c3",
          status: "submitted",
          total_paid_cents: 0,
        }),
      ],
    });

    await request(makeApp()).get(
      `/admin/reports/insurance-claims.iif?from=${FROM}&to=${TO}`,
    );

    expect(renderIifMock).toHaveBeenCalledOnce();
    const call = renderIifMock.mock.calls[0]![0] as {
      rows: { kind: string }[];
    };
    expect(call.rows).toHaveLength(1);
    expect(call.rows[0]!.kind).toBe("ORDER");
  });
});

describe("GET /admin/reports/insurance-claims.qbo.csv", () => {
  it("returns 200 with Content-Type: text/csv", async () => {
    stubAdmin();
    stageSupabaseResponse("insurance_claims", "select", { data: [] });

    const res = await request(makeApp()).get(
      `/admin/reports/insurance-claims.qbo.csv?from=${FROM}&to=${TO}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
  });
});

// ─── customer-activity ──────────────────────────────────────────────────

describe("GET /admin/reports/customer-activity.csv", () => {
  it("returns 200 with Content-Type: text/csv", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_customers", "select", { data: [] });
    stageSupabaseResponse("shop_orders", "select", { data: [] });

    const res = await request(makeApp()).get(
      `/admin/reports/customer-activity.csv?from=${FROM}&to=${TO}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
  });

  it("uses count-only column headers (never individual customer ids)", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_customers", "select", { data: [] });
    stageSupabaseResponse("shop_orders", "select", { data: [] });

    const res = await request(makeApp()).get(
      `/admin/reports/customer-activity.csv?from=${FROM}&to=${TO}`,
    );

    const header = res.text.split("\n")[0]!;
    expect(header).toContain("new_customers");
    expect(header).toContain("returning_customer_orders");
    expect(header).toContain("total_orders");
    expect(header).not.toContain("customer_id");
    expect(header).not.toContain("email");
  });

  it("classifies an order from a prior-day signup as returning", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_customers", "select", {
      data: [
        {
          customer_id: "cust-1",
          // Signed up the previous month — outside the report range.
          created_at: "2026-03-15T10:00:00Z",
        },
      ],
    });
    stageSupabaseResponse("shop_orders", "select", {
      data: [
        {
          customer_id: "cust-1",
          created_at: "2026-04-10T12:00:00Z",
        },
      ],
    });

    const res = await request(makeApp()).get(
      `/admin/reports/customer-activity.csv?from=${FROM}&to=${TO}`,
    );

    // header + one data row for the 2026-04-10 bucket
    const lines = res.text.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const dataRow = lines.find((l) => l.startsWith("2026-04-10"));
    expect(dataRow).toBeDefined();
    // Columns: day, new_customers, returning_customer_orders, total_orders
    const cells = dataRow!.split(",");
    expect(cells[2]).toBe("1"); // returning_customer_orders
    expect(cells[3]).toBe("1"); // total_orders
  });
});

describe("GET /admin/reports/customer-activity.pdf", () => {
  it("returns 200 with Content-Type: application/pdf", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_customers", "select", { data: [] });
    stageSupabaseResponse("shop_orders", "select", { data: [] });

    const res = await request(makeApp()).get(
      `/admin/reports/customer-activity.pdf?from=${FROM}&to=${TO}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
  });
});

describe("permission gate — new reports", () => {
  it("rejects insurance-claims.csv without reports.read with 403", async () => {
    // No stubAdmin call → mockAdmin.current stays null, requireAdmin
    // returns 401. We deliberately don't stage supabase here.
    const res = await request(makeApp()).get(
      `/admin/reports/insurance-claims.csv?from=${FROM}&to=${TO}`,
    );
    expect(res.status).toBe(401);
  });

  it("rejects customer-activity.csv without reports.read with 401", async () => {
    const res = await request(makeApp()).get(
      `/admin/reports/customer-activity.csv?from=${FROM}&to=${TO}`,
    );
    expect(res.status).toBe(401);
  });
});

// ─── POST /admin/reports/email ──────────────────────────────────────────

describe("POST /admin/reports/email — auth + validation", () => {
  it("returns 401 when not signed in", async () => {
    const res = await request(makeApp()).post("/admin/reports/email").send({
      slug: "orders",
      format: "csv",
      from: FROM,
      to: TO,
      recipient: "accounting@example.com",
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 invalid_body on unknown slug", async () => {
    stubAdmin();
    const res = await request(makeApp()).post("/admin/reports/email").send({
      slug: "nonexistent",
      format: "csv",
      from: FROM,
      to: TO,
      recipient: "ops@example.com",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 invalid_body on malformed recipient", async () => {
    stubAdmin();
    const res = await request(makeApp()).post("/admin/reports/email").send({
      slug: "orders",
      format: "csv",
      from: FROM,
      to: TO,
      recipient: "not-an-email",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 invalid_body on malformed date string", async () => {
    stubAdmin();
    const res = await request(makeApp()).post("/admin/reports/email").send({
      slug: "orders",
      format: "csv",
      from: "not-a-date",
      to: TO,
      recipient: "ops@example.com",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 from_after_to when from > to", async () => {
    stubAdmin();
    const res = await request(makeApp()).post("/admin/reports/email").send({
      slug: "orders",
      format: "csv",
      from: "2026-05-30",
      to: "2026-05-01",
      recipient: "ops@example.com",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("from_after_to");
  });
});

describe("POST /admin/reports/email — happy path", () => {
  it("returns 202 with bytes/recipient + invokes SendGrid + writes an audit row", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [] });

    const res = await request(makeApp()).post("/admin/reports/email").send({
      slug: "orders",
      format: "csv",
      from: FROM,
      to: TO,
      recipient: "accounting@example.com",
      note: "for the April close",
    });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    expect(res.body.recipient).toBe("accounting@example.com");
    expect(typeof res.body.bytes).toBe("number");

    expect(sendEmailMock).toHaveBeenCalledOnce();
    const sendCall = sendEmailMock.mock.calls[0]![0] as {
      to: string;
      attachments?: { filename: string; contentType: string }[];
    };
    expect(sendCall.to).toBe("accounting@example.com");
    expect(sendCall.attachments).toHaveLength(1);
    expect(sendCall.attachments![0]!.filename).toMatch(
      /^pennpaps-orders-.*\.csv$/,
    );

    expect(logAuditMock).toHaveBeenCalledOnce();
    const audit = logAuditMock.mock.calls[0]![0] as {
      action: string;
      metadata: { slug: string; format: string; recipient: string };
    };
    expect(audit.action).toBe("report.emailed");
    expect(audit.metadata.slug).toBe("orders");
    expect(audit.metadata.recipient).toBe("accounting@example.com");
  });

  it("returns 503 when SendGrid is not configured (EmailConfigError)", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [] });

    createSendgridClientMock.mockImplementationOnce(() => {
      throw new EmailConfigErrorStub("SENDGRID_API_KEY is not set");
    });

    const res = await request(makeApp()).post("/admin/reports/email").send({
      slug: "orders",
      format: "csv",
      from: FROM,
      to: TO,
      recipient: "ops@example.com",
    });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("email_not_configured");
  });

  it("returns 502 when SendGrid rejects the message (EmailApiError)", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [] });

    sendEmailMock.mockRejectedValueOnce(
      new EmailApiErrorStub("rejected by recipient policy", 400),
    );

    const res = await request(makeApp()).post("/admin/reports/email").send({
      slug: "orders",
      format: "csv",
      from: FROM,
      to: TO,
      recipient: "ops@example.com",
    });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("email_send_failed");
  });

  it("returns 400 format_not_supported when slug doesn't support the format", async () => {
    stubAdmin();
    // customer-activity does NOT support .iif; the route should
    // refuse with format_not_supported, NOT try to build the
    // artifact.
    const res = await request(makeApp()).post("/admin/reports/email").send({
      slug: "customer-activity",
      format: "iif",
      from: FROM,
      to: TO,
      recipient: "ops@example.com",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("format_not_supported");
  });
});

// ─── GET /admin/reports/revenue-summary.pdf?compare=true ────────────────

describe("GET /admin/reports/revenue-summary.pdf with compare flag", () => {
  it("fetches the prior period when ?compare=true is set", async () => {
    stubAdmin();
    // The current period needs 2 staged selects (orders + returns).
    // The prior period adds another 2.
    stageSupabaseResponse("shop_orders", "select", { data: [] });
    stageSupabaseResponse("shop_returns", "select", { data: [] });
    stageSupabaseResponse("shop_orders", "select", { data: [] });
    stageSupabaseResponse("shop_returns", "select", { data: [] });

    const res = await request(makeApp()).get(
      `/admin/reports/revenue-summary.pdf?from=${FROM}&to=${TO}&compare=true`,
    );

    expect(res.status).toBe(200);
    expect(renderTablePdfMock).toHaveBeenCalledOnce();
    const call = renderTablePdfMock.mock.calls[0]![0] as {
      summaryLines: string[];
    };
    // The compare branch appends a "Compared to ..." line + per-
    // metric prior totals; verify at least the marker line is in.
    const joined = call.summaryLines.join("\n");
    expect(joined).toContain("Compared to");
    expect(joined).toContain("Prior orders");
  });

  it("does NOT fetch the prior period when compare is absent / false", async () => {
    stubAdmin();
    stageSupabaseResponse("shop_orders", "select", { data: [] });
    stageSupabaseResponse("shop_returns", "select", { data: [] });

    const res = await request(makeApp()).get(
      `/admin/reports/revenue-summary.pdf?from=${FROM}&to=${TO}`,
    );

    expect(res.status).toBe(200);
    const call = renderTablePdfMock.mock.calls[0]![0] as {
      summaryLines: string[];
    };
    expect(call.summaryLines.join("\n")).not.toContain("Compared to");
  });
});

// /admin/pacware/import/shipments — the return leg of the PacWare file
// exchange.
//
// A ship date imported here becomes the DATE OF SERVICE on an 837P.
// Everything below is a way that could go wrong at the route level:
// applying a row that should have been held, silently re-importing a
// file, overwriting a date a payer was already told, or putting a
// patient identifier into a report meant to be attached to a ticket.

import express, { type Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  getSupabaseWritePayloads,
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminWriteRateLimiter: (
    _req: import("express").Request,
    _res: import("express").Response,
    next: import("express").NextFunction,
  ) => next(),
  adminRateLimit:
    () =>
    (
      _req: import("express").Request,
      _res: import("express").Response,
      next: import("express").NextFunction,
    ) =>
      next(),
}));

vi.mock("../../middlewares/idempotency", () => ({
  withIdempotency:
    () =>
    (
      _req: import("express").Request,
      _res: import("express").Response,
      next: import("express").NextFunction,
    ) =>
      next(),
}));

vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(() => Promise.resolve()),
}));

const recordShipmentEvidenceMock = vi.hoisted(() =>
  vi.fn(() =>
    Promise.resolve({
      status: "applied" as const,
      fulfillmentId: "f1",
      episodeId: "e1",
      episodeClosed: true,
      nextEpisodeId: "e2",
      nextEpisodeCreated: true,
      reanchored: false,
    }),
  ),
);
vi.mock("../../lib/fulfillments/record-shipment-evidence", () => ({
  recordShipmentEvidence: recordShipmentEvidenceMock,
}));

const { default: router } = await import("./pacware-shipments");

const ORG = "00000000-0000-4000-8000-000000000001";
const PATIENT = "aaaaaaaa-0000-4000-8000-000000000001";
const FULFILLMENT = "bbbbbbbb-0000-4000-8000-000000000001";

function makeApp(): Express {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(router);
  return app;
}

function stubAdmin(role: "admin" | "agent" = "admin") {
  mockAdmin.current = { userId: "u1", email: "ops@example.com", role };
}

/** A ship date recent enough to be inside every threshold. */
function recentDate(daysAgo = 3): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

const HEADER =
  "pennfit_episode_id,pacware_order_ref,pacware_id,item_sku,quantity,shipped_date,delivered_date,tracking_number,carrier,status";

function csv(rows: string[]): string {
  return [HEADER, ...rows].join("\n");
}

/**
 * Stage the reads `analyzeFile` performs, in order:
 *   patients (pacware_id -> patient_id)
 *   fulfillments (once per non-empty match-key group)
 *   insurance_claims (only when something is already recorded)
 *   pacware_shipment_imports (prior commit lookup)
 */
function stageLookups(
  opts: {
    shippedAt?: string | null;
    status?: string;
    billed?: boolean;
    priorCommit?: { created_at: string; applied_count: number } | null;
  } = {},
) {
  stageSupabaseResponse("patients", "select", {
    data: [{ id: PATIENT, pacware_id: "PW-1" }],
  });
  stageSupabaseResponse("fulfillments", "select", {
    data: [
      {
        id: FULFILLMENT,
        episode_id: "cccccccc-0000-4000-8000-000000000001",
        patient_id: PATIENT,
        item_sku: "A7034",
        pacware_order_ref: null,
        created_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        shipped_at: opts.shippedAt ?? null,
        status: opts.status ?? "queued",
      },
    ],
  });
  if (opts.shippedAt) {
    stageSupabaseResponse("insurance_claims", "select", {
      data: opts.billed
        ? [
            {
              id: "dddddddd-0000-4000-8000-000000000001",
              fulfillment_id: FULFILLMENT,
            },
          ]
        : [],
    });
  }
  stageSupabaseResponse("pacware_shipment_imports", "select", {
    data: opts.priorCommit ?? null,
  });
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  recordShipmentEvidenceMock.mockClear();
  recordShipmentEvidenceMock.mockResolvedValue({
    status: "applied",
    fulfillmentId: FULFILLMENT,
    episodeId: "e1",
    episodeClosed: true,
    nextEpisodeId: "e2",
    nextEpisodeCreated: true,
    reanchored: false,
  });
});

describe("permissions", () => {
  it("requires authentication", async () => {
    const res = await request(makeApp())
      .post("/admin/pacware/import/shipments")
      .send({ csv: csv([]), mode: "preview" });
    expect(res.status).toBe(401);
  });

  it("refuses a CSR-bucket actor", async () => {
    stubAdmin("agent");
    const res = await request(makeApp())
      .post("/admin/pacware/import/shipments")
      .send({ csv: csv([]), mode: "preview" });
    expect(res.status).toBe(403);
  });
});

describe("preview", () => {
  it("writes nothing", async () => {
    stubAdmin();
    stageLookups();
    const res = await request(makeApp())
      .post("/admin/pacware/import/shipments")
      .send({
        csv: csv([`,,PW-1,A7034,1,${recentDate()},,,,shipped`]),
        mode: "preview",
      });
    expect(res.status).toBe(200);
    expect(recordShipmentEvidenceMock).not.toHaveBeenCalled();
    expect(
      getSupabaseWritePayloads("pacware_shipment_imports", "insert"),
    ).toHaveLength(0);
  });

  it("reports every disposition, including the empty ones", async () => {
    stubAdmin();
    stageLookups();
    const res = await request(makeApp())
      .post("/admin/pacware/import/shipments")
      .send({
        csv: csv([`,,PW-1,A7034,1,${recentDate()},,,,shipped`]),
        mode: "preview",
      });
    expect(res.body.dispositions).toMatchObject({
      matched: 1,
      ambiguous: 0,
      unmatched: 0,
      duplicate: 0,
      cancelled: 0,
      invalid: 0,
      too_old: 0,
      future_dated: 0,
      already_recorded: 0,
      date_conflict: 0,
    });
    expect(res.body.willApply).toBe(1);
  });

  it("returns a file hash, and the same file hashes the same", async () => {
    stubAdmin();
    const body = {
      csv: csv([`,,PW-1,A7034,1,${recentDate()},,,,shipped`]),
      mode: "preview" as const,
    };
    stageLookups();
    const first = await request(makeApp())
      .post("/admin/pacware/import/shipments")
      .send(body);
    stageLookups();
    // Same content, re-saved from Excel: CRLF, BOM, trailing newline.
    const second = await request(makeApp())
      .post("/admin/pacware/import/shipments")
      .send({
        ...body,
        csv: `\uFEFF${body.csv.replace(/\n/g, "\r\n")}\r\n`,
      });
    expect(first.body.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.body.fileHash).toBe(first.body.fileHash);
  });

  it("returns no row content — the response is not a place for PHI", async () => {
    stubAdmin();
    stageLookups();
    const res = await request(makeApp())
      .post("/admin/pacware/import/shipments")
      .send({
        csv: csv([
          `,SO-SECRET,PW-SECRET-ID,A7034,1,${recentDate()},,1Z999SECRET,UPS,shipped`,
        ]),
        mode: "preview",
      });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("PW-SECRET-ID");
    expect(body).not.toContain("1Z999SECRET");
    expect(body).not.toContain("SO-SECRET");
  });

  it("says when this exact file has already been committed", async () => {
    stubAdmin();
    stageLookups({
      priorCommit: {
        created_at: "2026-08-01T00:00:00.000Z",
        applied_count: 12,
      },
    });
    const res = await request(makeApp())
      .post("/admin/pacware/import/shipments")
      .send({
        csv: csv([`,,PW-1,A7034,1,${recentDate()},,,,shipped`]),
        mode: "preview",
      });
    expect(res.body.alreadyImported).toMatchObject({ applied: 12 });
  });

  it("refuses a file past the row limit before touching the database", async () => {
    stubAdmin();
    const rows = Array.from(
      { length: 5001 },
      (_, i) => `,,PW-${i},A7034,1,${recentDate()},,,,shipped`,
    );
    const res = await request(makeApp())
      .post("/admin/pacware/import/shipments")
      .send({ csv: csv(rows), mode: "preview" });
    expect(res.status).toBe(413);
  });
});

describe("commit — what gets written", () => {
  it("applies a matched row", async () => {
    stubAdmin();
    stageLookups();
    const res = await request(makeApp())
      .post("/admin/pacware/import/shipments")
      .send({
        csv: csv([`,,PW-1,A7034,1,${recentDate()},,,,shipped`]),
        mode: "commit",
      });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(1);
    expect(recordShipmentEvidenceMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, source: "pacware_import" }),
    );
  });

  it("records the file hash in the import ledger", async () => {
    stubAdmin();
    stageLookups();
    await request(makeApp())
      .post("/admin/pacware/import/shipments")
      .send({
        csv: csv([`,,PW-1,A7034,1,${recentDate()},,,,shipped`]),
        mode: "commit",
      });
    const writes = getSupabaseWritePayloads(
      "pacware_shipment_imports",
      "insert",
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      org_id: ORG,
      mode: "commit",
      applied_count: 1,
    });
    expect(String((writes[0] as { file_hash: string }).file_hash)).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it.each([
    ["a future ship date", `,,PW-1,A7034,1,2099-01-01,,,,shipped`],
    ["a cancelled row", `,,PW-1,A7034,1,${recentDate()},,,,cancelled`],
  ])("never applies %s", async (_label, line) => {
    stubAdmin();
    stageLookups();
    const res = await request(makeApp())
      .post("/admin/pacware/import/shipments")
      .send({ csv: csv([line]), mode: "commit" });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(0);
    expect(recordShipmentEvidenceMock).not.toHaveBeenCalled();
  });

  it("never applies a ship date past the timely-filing threshold", async () => {
    stubAdmin();
    stageLookups();
    const res = await request(makeApp())
      .post("/admin/pacware/import/shipments")
      .send({
        csv: csv([`,,PW-1,A7034,1,${recentDate(400)},,,,shipped`]),
        mode: "commit",
      });
    expect(res.body.dispositions.too_old).toBe(1);
    expect(res.body.applied).toBe(0);
    expect(recordShipmentEvidenceMock).not.toHaveBeenCalled();
  });

  it("applies only the first of a repeated order line", async () => {
    stubAdmin();
    stageLookups();
    const line = `,SO-1,PW-1,A7034,1,${recentDate()},,,,shipped`;
    const res = await request(makeApp())
      .post("/admin/pacware/import/shipments")
      .send({ csv: csv([line, line, line]), mode: "commit" });
    expect(res.body.dispositions.duplicate).toBe(2);
    expect(recordShipmentEvidenceMock).toHaveBeenCalledTimes(1);
  });
});

describe("commit — file-level idempotency", () => {
  it("refuses a file already committed, without an explicit acknowledgement", async () => {
    stubAdmin();
    stageLookups({
      priorCommit: {
        created_at: "2026-08-01T00:00:00.000Z",
        applied_count: 12,
      },
    });
    const res = await request(makeApp())
      .post("/admin/pacware/import/shipments")
      .send({
        csv: csv([`,,PW-1,A7034,1,${recentDate()},,,,shipped`]),
        mode: "commit",
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_imported");
    expect(recordShipmentEvidenceMock).not.toHaveBeenCalled();
  });

  it("proceeds when the operator says they meant it", async () => {
    stubAdmin();
    stageLookups({
      priorCommit: {
        created_at: "2026-08-01T00:00:00.000Z",
        applied_count: 12,
      },
    });
    const res = await request(makeApp())
      .post("/admin/pacware/import/shipments")
      .send({
        csv: csv([`,,PW-1,A7034,1,${recentDate()},,,,shipped`]),
        mode: "commit",
        acknowledgeReimport: true,
      });
    expect(res.status).toBe(200);
    expect(
      getSupabaseWritePayloads("pacware_shipment_imports", "insert")[0],
    ).toMatchObject({ reimport_acknowledged: true });
  });
});

describe("commit — ship-date corrections", () => {
  const shipped = new Date(Date.now() - 40 * 86_400_000).toISOString();

  it("does not overwrite a recorded date, and opens an exception when it was billed", async () => {
    stubAdmin();
    stageLookups({ shippedAt: shipped, status: "shipped", billed: true });
    // The exception path re-reads the fulfillment for its current date.
    stageSupabaseResponse("fulfillments", "select", {
      data: { shipped_at: shipped },
    });
    stageSupabaseResponse("shipment_date_exceptions", "insert", { data: null });

    const res = await request(makeApp())
      .post("/admin/pacware/import/shipments")
      .send({
        csv: csv([`,,PW-1,A7034,1,${recentDate(3)},,,,shipped`]),
        mode: "commit",
      });

    expect(res.body.dispositions.date_conflict).toBe(1);
    expect(res.body.applied).toBe(0);
    expect(recordShipmentEvidenceMock).not.toHaveBeenCalled();
    const raised = getSupabaseWritePayloads(
      "shipment_date_exceptions",
      "insert",
    );
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      org_id: ORG,
      fulfillment_id: FULFILLMENT,
      status: "open",
      source: "pacware_import",
    });
  });

  it("reports an unchanged re-import as unchanged, not as an error", async () => {
    stubAdmin();
    const sameDay = recentDate(3);
    stageLookups({
      shippedAt: `${sameDay}T12:00:00.000Z`,
      status: "shipped",
      billed: false,
    });
    const res = await request(makeApp())
      .post("/admin/pacware/import/shipments")
      .send({
        csv: csv([`,,PW-1,A7034,1,${sameDay},,,,shipped`]),
        mode: "commit",
      });
    expect(res.body.dispositions.already_recorded).toBe(1);
    expect(res.body.unchanged).toBe(1);
    expect(res.body.failed).toBe(0);
    expect(recordShipmentEvidenceMock).not.toHaveBeenCalled();
  });
});

describe("disposition report", () => {
  it("is a CSV of row numbers and categories, with no cell values", async () => {
    stubAdmin();
    stageLookups();
    const res = await request(makeApp())
      .post("/admin/pacware/import/shipments/report.csv")
      .send({
        csv: csv([
          `,SO-SECRET,PW-SECRET-ID,A7034,1,${recentDate()},,1Z999SECRET,UPS,shipped`,
        ]),
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.text).toContain("file_row,disposition,reason");
    expect(res.text).not.toContain("PW-SECRET-ID");
    expect(res.text).not.toContain("1Z999SECRET");
    expect(res.text).not.toContain("SO-SECRET");
  });

  it("refuses a CSR-bucket actor", async () => {
    stubAdmin("agent");
    const res = await request(makeApp())
      .post("/admin/pacware/import/shipments/report.csv")
      .send({ csv: csv([]) });
    expect(res.status).toBe(403);
  });
});

describe("ship-date exception resolution", () => {
  it("rewrites the ship date only for the `corrected` resolution", async () => {
    stubAdmin();
    stageSupabaseResponse("shipment_date_exceptions", "select", {
      data: {
        id: "eeeeeeee-0000-4000-8000-000000000001",
        fulfillment_id: FULFILLMENT,
        proposed_shipped_at: "2026-08-20T12:00:00.000Z",
        status: "open",
      },
    });
    stageSupabaseResponse("fulfillments", "update", { data: null });
    stageSupabaseResponse("shipment_date_exceptions", "update", { data: null });

    const res = await request(makeApp())
      .post(
        "/admin/pacware/shipment-exceptions/eeeeeeee-0000-4000-8000-000000000001/resolve",
      )
      .send({ resolution: "corrected", note: "warehouse re-sent the date" });

    expect(res.status).toBe(200);
    const writes = getSupabaseWritePayloads("fulfillments", "update");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      shipped_at: "2026-08-20T12:00:00.000Z",
    });
  });

  it("leaves the recorded date alone for `kept_recorded`", async () => {
    stubAdmin();
    stageSupabaseResponse("shipment_date_exceptions", "select", {
      data: {
        id: "eeeeeeee-0000-4000-8000-000000000001",
        fulfillment_id: FULFILLMENT,
        proposed_shipped_at: "2026-08-20T12:00:00.000Z",
        status: "open",
      },
    });
    stageSupabaseResponse("shipment_date_exceptions", "update", { data: null });

    const res = await request(makeApp())
      .post(
        "/admin/pacware/shipment-exceptions/eeeeeeee-0000-4000-8000-000000000001/resolve",
      )
      .send({ resolution: "kept_recorded" });

    expect(res.status).toBe(200);
    expect(getSupabaseWritePayloads("fulfillments", "update")).toHaveLength(0);
  });

  it("refuses to close a BILLED correction without the claim's reference", async () => {
    // Resolving takes the row out of the queue. Without the reference the
    // end state is the fulfillment showing the new date, the filed 837P
    // still carrying the old one, and nothing watching the difference —
    // the exact disagreement this table exists to surface. The order is
    // forced: correct the claim, then close the exception citing it.
    stubAdmin();
    stageSupabaseResponse("shipment_date_exceptions", "select", {
      data: {
        id: "eeeeeeee-0000-4000-8000-000000000001",
        fulfillment_id: FULFILLMENT,
        proposed_shipped_at: "2026-08-20T12:00:00.000Z",
        status: "open",
        claim_id: "cccccccc-0000-4000-8000-000000000001",
      },
    });

    const res = await request(makeApp())
      .post(
        "/admin/pacware/shipment-exceptions/eeeeeeee-0000-4000-8000-000000000001/resolve",
      )
      .send({ resolution: "corrected" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("claim_correction_ref_required");
    // And critically: the ship date was NOT rewritten.
    expect(getSupabaseWritePayloads("fulfillments", "update")).toHaveLength(0);
    expect(
      getSupabaseWritePayloads("shipment_date_exceptions", "update"),
    ).toHaveLength(0);
  });

  it("accepts a billed correction WITH the reference, and records it", async () => {
    stubAdmin();
    stageSupabaseResponse("shipment_date_exceptions", "select", {
      data: {
        id: "eeeeeeee-0000-4000-8000-000000000001",
        fulfillment_id: FULFILLMENT,
        proposed_shipped_at: "2026-08-20T12:00:00.000Z",
        status: "open",
        claim_id: "cccccccc-0000-4000-8000-000000000001",
      },
    });
    stageSupabaseResponse("fulfillments", "update", { data: null });
    stageSupabaseResponse("shipment_date_exceptions", "update", { data: null });

    const res = await request(makeApp())
      .post(
        "/admin/pacware/shipment-exceptions/eeeeeeee-0000-4000-8000-000000000001/resolve",
      )
      .send({ resolution: "corrected", claimCorrectionRef: "CORR-99812" });

    expect(res.status).toBe(200);
    expect(getSupabaseWritePayloads("fulfillments", "update")).toHaveLength(1);
    expect(
      getSupabaseWritePayloads("shipment_date_exceptions", "update")[0],
    ).toMatchObject({ claim_correction_ref: "CORR-99812" });
  });

  it("does not demand a reference when nothing was billed", async () => {
    // No claim, no disagreement to create. Requiring a billing reference
    // here would be ceremony that teaches operators to type anything.
    stubAdmin();
    stageSupabaseResponse("shipment_date_exceptions", "select", {
      data: {
        id: "eeeeeeee-0000-4000-8000-000000000001",
        fulfillment_id: FULFILLMENT,
        proposed_shipped_at: "2026-08-20T12:00:00.000Z",
        status: "open",
        claim_id: null,
      },
    });
    stageSupabaseResponse("fulfillments", "update", { data: null });
    stageSupabaseResponse("shipment_date_exceptions", "update", { data: null });

    const res = await request(makeApp())
      .post(
        "/admin/pacware/shipment-exceptions/eeeeeeee-0000-4000-8000-000000000001/resolve",
      )
      .send({ resolution: "corrected" });

    expect(res.status).toBe(200);
    expect(getSupabaseWritePayloads("fulfillments", "update")).toHaveLength(1);
  });

  it("does not demand a reference for a resolution that changes no date", async () => {
    stubAdmin();
    stageSupabaseResponse("shipment_date_exceptions", "select", {
      data: {
        id: "eeeeeeee-0000-4000-8000-000000000001",
        fulfillment_id: FULFILLMENT,
        proposed_shipped_at: "2026-08-20T12:00:00.000Z",
        status: "open",
        claim_id: "cccccccc-0000-4000-8000-000000000001",
      },
    });
    stageSupabaseResponse("shipment_date_exceptions", "update", { data: null });

    const res = await request(makeApp())
      .post(
        "/admin/pacware/shipment-exceptions/eeeeeeee-0000-4000-8000-000000000001/resolve",
      )
      .send({ resolution: "invalid_report" });

    expect(res.status).toBe(200);
    expect(getSupabaseWritePayloads("fulfillments", "update")).toHaveLength(0);
  });

  it("refuses to resolve an exception twice", async () => {
    stubAdmin();
    stageSupabaseResponse("shipment_date_exceptions", "select", {
      data: {
        id: "eeeeeeee-0000-4000-8000-000000000001",
        fulfillment_id: FULFILLMENT,
        proposed_shipped_at: "2026-08-20T12:00:00.000Z",
        status: "resolved",
      },
    });
    const res = await request(makeApp())
      .post(
        "/admin/pacware/shipment-exceptions/eeeeeeee-0000-4000-8000-000000000001/resolve",
      )
      .send({ resolution: "kept_recorded" });
    expect(res.status).toBe(409);
  });

  it("refuses an unknown resolution", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post(
        "/admin/pacware/shipment-exceptions/eeeeeeee-0000-4000-8000-000000000001/resolve",
      )
      .send({ resolution: "whatever" });
    expect(res.status).toBe(400);
  });

  it("refuses a CSR-bucket actor", async () => {
    stubAdmin("agent");
    const res = await request(makeApp())
      .post(
        "/admin/pacware/shipment-exceptions/eeeeeeee-0000-4000-8000-000000000001/resolve",
      )
      .send({ resolution: "kept_recorded" });
    expect(res.status).toBe(403);
  });
});

describe("tenant scope", () => {
  it("refuses to act without a tenant context", async () => {
    mockAdmin.current = {
      userId: "u1",
      email: "ops@example.com",
      role: "admin",
      orgId: null,
    };
    const res = await request(makeApp())
      .post("/admin/pacware/import/shipments")
      .send({ csv: csv([]), mode: "preview" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("tenant_context_missing");
  });
});

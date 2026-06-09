// Route tests for the PacWare file-exchange endpoints.
//
// Mocks Supabase + requireAdmin/requirePermission + logAudit via the
// shared helpers. Verifies the sync upsert touches ONLY the columns the
// uploaded report carried (the data-loss-safety invariant) and that
// errors never echo the offending cell value (PHI).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const logAuditMock = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

import pacwareRouter from "./pacware";

function makeApp(): Express {
  const app = express();
  app.use(express.json({ limit: "12mb" }));
  app.use("/resupply-api", pacwareRouter);
  return app;
}

function asAdmin(): void {
  mockAdmin.current = {
    userId: "u1",
    email: "ops@penn.example.com",
    role: "admin",
  };
}

const HEADER =
  "pacware_id,legal_first_name,legal_last_name,date_of_birth,phone_e164,insurance_payer";

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
  delete process.env.PACWARE_EXCHANGE_DISABLED;
  asAdmin();
});

afterEach(() => {
  delete process.env.PACWARE_EXCHANGE_DISABLED;
});

describe("GET /admin/pacware/status", () => {
  it("returns availability + the report catalog", async () => {
    const res = await request(makeApp()).get(
      "/resupply-api/admin/pacware/status",
    );
    expect(res.status).toBe(200);
    expect(res.body.availability.status).toBe("configured");
    const kinds = res.body.reports.map((r: { kind: string }) => r.kind);
    expect(kinds).toContain("patient_roster");
    expect(kinds).toContain("resupply_due");
    const roster = res.body.reports.find(
      (r: { kind: string }) => r.kind === "patient_roster",
    );
    expect(roster.columns[0].header).toBe("pacware_id");
  });

  it("401s when unauthenticated", async () => {
    mockAdmin.current = null;
    const res = await request(makeApp()).get(
      "/resupply-api/admin/pacware/status",
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /admin/pacware/import/patients (preview)", () => {
  it("validates without writing and reports counts + errors", async () => {
    const csv = [
      HEADER,
      "PW1,Jane,Doe,1970-05-04,+14155551212,Medicare",
      "PW2,Bob,,1980-01-01,,", // missing last name -> error
    ].join("\n");
    const res = await request(makeApp())
      .post("/resupply-api/admin/pacware/import/patients")
      .send({ csv, mode: "preview" });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("preview");
    expect(res.body.validCount).toBe(1);
    expect(res.body.errorCount).toBe(1);
    expect(res.body.errors[0].rowIndex).toBe(2);
    expect(res.headers["cache-control"]).toBe("no-store");
    // No DB writes on preview.
    expect(getSupabaseWritePayloads("patients", "upsert")).toHaveLength(0);
    // The preview body must NOT carry patient rows (PHI) — if it did and a
    // caller passed an Idempotency-Key, the PHI would be persisted.
    expect(res.body).not.toHaveProperty("sample");
    expect(JSON.stringify(res.body)).not.toContain("Jane");
  });

  it("never echoes the offending cell value in an error", async () => {
    const csv = [
      "pacware_id,legal_first_name,legal_last_name,date_of_birth",
      "PW1,Jane,Doe,05/04/1970",
    ].join("\n");
    const res = await request(makeApp())
      .post("/resupply-api/admin/pacware/import/patients")
      .send({ csv });
    expect(res.body.errors[0].field).toBe("dateOfBirth");
    expect(JSON.stringify(res.body.errors)).not.toContain("05/04/1970");
  });
});

describe("POST /admin/pacware/import/patients (commit)", () => {
  it("inserts new patients and audits created/updated/unchanged", async () => {
    stageSupabaseResponse("patients", "select", { data: [] }); // none exist
    stageSupabaseResponse("patients", "insert", { data: null, error: null });
    const csv = [
      HEADER,
      "PW1,Jane,Doe,1970-05-04,+14155551212,Medicare",
      "PW2,Bob,Roe,1980-01-01,,Aetna",
    ].join("\n");
    const res = await request(makeApp())
      .post("/resupply-api/admin/pacware/import/patients")
      .send({ csv, mode: "commit" });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("commit");
    expect(res.body.created).toBe(2);
    expect(res.body.updated).toBe(0);
    expect(res.body.unchanged).toBe(0);

    const inserts = (getSupabaseWritePayloads("patients", "insert")[0] ??
      []) as Array<Record<string, unknown>>;
    expect(inserts).toHaveLength(2);
    expect(inserts[0].phone_e164).toBe("+14155551212");

    const arg = (logAuditMock.mock.calls[0] as unknown[])[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(arg.action).toBe("patient.pacware_sync");
    expect(arg.metadata.created).toBe(2);
  });

  it("NEVER overwrites a populated field — fills only blanks", async () => {
    // PW1 exists with a phone already set but no email / insurance.
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: "p1",
          pacware_id: "PW1",
          legal_first_name: "Jane",
          legal_last_name: "Doe",
          date_of_birth: "1970-05-04",
          phone_e164: "+14150000000", // already populated
          email: null, // blank -> fillable
          insurance_payer: null, // blank -> fillable
          address: null,
        },
      ],
    });
    stageSupabaseResponse("patients", "update", { data: null, error: null });
    const csv = [
      "pacware_id,legal_first_name,legal_last_name,date_of_birth,phone_e164,email,insurance_payer",
      "PW1,Jane,Doe,1970-05-04,+14159999999,jane@example.com,Medicare",
    ].join("\n");
    const res = await request(makeApp())
      .post("/resupply-api/admin/pacware/import/patients")
      .send({ csv, mode: "commit" });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(0);
    expect(res.body.updated).toBe(1);

    const patch = (getSupabaseWritePayloads("patients", "update")[0] ??
      {}) as Record<string, unknown>;
    // Phone was already populated → untouched. Email + insurance were blank → filled.
    expect(patch).not.toHaveProperty("phone_e164");
    expect(patch.email).toBe("jane@example.com");
    expect(patch.insurance_payer).toBe("Medicare");
  });

  it("counts an existing fully-populated patient as unchanged (no write)", async () => {
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: "p1",
          pacware_id: "PW1",
          legal_first_name: "Jane",
          legal_last_name: "Doe",
          date_of_birth: "1970-05-04",
          phone_e164: "+14150000000",
          email: "jane@example.com",
          insurance_payer: "Medicare",
          address: null,
        },
      ],
    });
    const csv = [
      "pacware_id,legal_first_name,legal_last_name,date_of_birth,phone_e164",
      "PW1,Jane,Doe,1970-05-04,+14159999999",
    ].join("\n");
    const res = await request(makeApp())
      .post("/resupply-api/admin/pacware/import/patients")
      .send({ csv, mode: "commit" });
    expect(res.body.created).toBe(0);
    expect(res.body.updated).toBe(0);
    expect(res.body.unchanged).toBe(1);
    expect(getSupabaseWritePayloads("patients", "update")).toHaveLength(0);
  });

  it("omits columns the report did not contain (insert)", async () => {
    stageSupabaseResponse("patients", "select", { data: [] });
    stageSupabaseResponse("patients", "insert", { data: null, error: null });
    const csv = [
      "pacware_id,legal_first_name,legal_last_name,date_of_birth",
      "PW1,Jane,Doe,1970-05-04",
    ].join("\n");
    await request(makeApp())
      .post("/resupply-api/admin/pacware/import/patients")
      .send({ csv, mode: "commit" });
    const inserts = (getSupabaseWritePayloads("patients", "insert")[0] ??
      []) as Array<Record<string, unknown>>;
    expect(inserts[0]).not.toHaveProperty("phone_e164");
    expect(inserts[0]).not.toHaveProperty("insurance_payer");
    expect(inserts[0]).not.toHaveProperty("address");
    expect(inserts[0].pacware_id).toBe("PW1");
  });

  it("dedupes a repeated pacware_id within the file (last wins)", async () => {
    stageSupabaseResponse("patients", "select", { data: [] });
    stageSupabaseResponse("patients", "insert", { data: null, error: null });
    const csv = [
      "pacware_id,legal_first_name,legal_last_name,date_of_birth",
      "PW1,Jane,Doe,1970-05-04",
      "PW1,Janet,Doe,1970-05-04",
    ].join("\n");
    const res = await request(makeApp())
      .post("/resupply-api/admin/pacware/import/patients")
      .send({ csv, mode: "commit" });
    expect(res.body.created).toBe(1);
    const inserts = (getSupabaseWritePayloads("patients", "insert")[0] ??
      []) as Array<Record<string, unknown>>;
    expect(inserts).toHaveLength(1);
    expect(inserts[0].legal_first_name).toBe("Janet");
  });
});

describe("GET /admin/pacware/export/patients.csv", () => {
  it("emits the roster layout with a flattened address", async () => {
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          pacware_id: "PW1",
          legal_first_name: "Jane",
          legal_last_name: "Doe",
          date_of_birth: "1970-05-04",
          phone_e164: "+14155551212",
          email: "jane@example.com",
          address: {
            line1: "123 Main St",
            city: "Philadelphia",
            state: "PA",
            postalCode: "19104",
            country: "US",
          },
          insurance_payer: "Medicare",
        },
      ],
    });
    const res = await request(makeApp()).get(
      "/resupply-api/admin/pacware/export/patients.csv",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(
      /pacware-patient-roster\.csv/,
    );
    const lines = res.text.trim().split("\r\n");
    expect(lines[0].split(",")).toContain("address_line1");
    expect(lines[1]).toContain("123 Main St");
    expect(lines[1]).toContain("Philadelphia");
    expect(lines[1]).toContain("Medicare");
  });
});

describe("GET /admin/pacware/export/resupply-due.csv", () => {
  it("flattens the episode/prescription/patient join into one line per item", async () => {
    stageSupabaseResponse("episodes", "select", {
      data: [
        {
          id: "ep_1",
          status: "confirmed",
          due_at: "2026-06-15T00:00:00.000Z",
          prescriptions: { item_sku: "MASK-N20-M" },
          patients: {
            pacware_id: "PW1",
            legal_first_name: "Jane",
            legal_last_name: "Doe",
            insurance_payer: "Medicare",
          },
        },
      ],
    });
    const res = await request(makeApp()).get(
      "/resupply-api/admin/pacware/export/resupply-due.csv",
    );
    expect(res.status).toBe(200);
    const lines = res.text.trim().split("\r\n");
    expect(lines[0].split(",")).toContain("pennfit_episode_id");
    expect(lines[1]).toContain("PW1");
    expect(lines[1]).toContain("MASK-N20-M");
    expect(lines[1]).toContain("2026-06-15");
    expect(lines[1]).toContain("ep_1");
  });

  it("rejects an unknown status filter with 400", async () => {
    const res = await request(makeApp()).get(
      "/resupply-api/admin/pacware/export/resupply-due.csv?status=banana",
    );
    expect(res.status).toBe(400);
  });
});

describe("partial write failure", () => {
  it("returns 502 (not a cacheable 200) when an insert fails", async () => {
    stageSupabaseResponse("patients", "select", { data: [] });
    stageSupabaseResponse("patients", "insert", {
      data: null,
      error: { message: "db down" },
    });
    const csv = [
      "pacware_id,legal_first_name,legal_last_name,date_of_birth",
      "PW1,Jane,Doe,1970-05-04",
    ].join("\n");
    const res = await request(makeApp())
      .post("/resupply-api/admin/pacware/import/patients")
      .send({ csv, mode: "commit" });
    expect(res.status).toBe(502);
    expect(res.body.created).toBe(0);
    expect(res.body.batchErrors.length).toBe(1);
  });
});

describe("address-column safety", () => {
  it("does not write the address column when only address_line2 is present", async () => {
    stageSupabaseResponse("patients", "select", { data: [] });
    stageSupabaseResponse("patients", "insert", { data: null, error: null });
    // Header carries address_line2 but none of line1/city/state/postal.
    const csv = [
      "pacware_id,legal_first_name,legal_last_name,date_of_birth,address_line2",
      "PW1,Jane,Doe,1970-05-04,Apt 4",
    ].join("\n");
    await request(makeApp())
      .post("/resupply-api/admin/pacware/import/patients")
      .send({ csv, mode: "commit" });
    const inserts = (getSupabaseWritePayloads("patients", "insert")[0] ??
      []) as Array<Record<string, unknown>>;
    expect(inserts[0]).not.toHaveProperty("address");
  });
});

describe("sync verify + settings", () => {
  it("previews the resupply-due worklist (count + sample, no CSV)", async () => {
    stageSupabaseResponse("episodes", "select", { data: null, count: 7 }); // head count
    stageSupabaseResponse("episodes", "select", {
      data: [
        {
          id: "ep_1",
          status: "confirmed",
          due_at: "2026-06-15T00:00:00.000Z",
          prescriptions: { item_sku: "MASK-N20-M" },
          patients: {
            pacware_id: "PW1",
            legal_first_name: "Jane",
            legal_last_name: "Doe",
            insurance_payer: "Medicare",
          },
        },
      ],
    });
    const res = await request(makeApp()).get(
      "/resupply-api/admin/pacware/sync/resupply-due/preview",
    );
    expect(res.status).toBe(200);
    expect(res.body.target).toBe("resupply_due");
    expect(res.body.count).toBe(7);
    expect(res.body.sample[0].itemSku).toBe("MASK-N20-M");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("returns settings (autoSync default false) + live pending counts", async () => {
    stageSupabaseResponse("app_config", "select", { data: null }); // no toggle row
    stageSupabaseResponse("episodes", "select", { data: null, count: 3 });
    stageSupabaseResponse("patients", "select", { data: null, count: 42 });
    const res = await request(makeApp()).get(
      "/resupply-api/admin/pacware/settings",
    );
    expect(res.status).toBe(200);
    expect(res.body.autoSync).toBe(false);
    expect(res.body.pending.resupplyDue).toBe(3);
    expect(res.body.pending.patients).toBe(42);
  });

  it("persists the autoSync toggle", async () => {
    stageSupabaseResponse("app_config", "upsert", { data: null, error: null });
    const res = await request(makeApp())
      .put("/resupply-api/admin/pacware/settings")
      .send({ autoSync: true });
    expect(res.status).toBe(200);
    expect(res.body.autoSync).toBe(true);
    const writes = getSupabaseWritePayloads("app_config", "upsert");
    expect(writes).toHaveLength(1);
    expect((writes[0] as Record<string, unknown>).value).toBe("true");
  });
});

describe("PACWARE_EXCHANGE_DISABLED kill switch", () => {
  it("503s the import + export endpoints but still serves status", async () => {
    process.env.PACWARE_EXCHANGE_DISABLED = "1";

    const status = await request(makeApp()).get(
      "/resupply-api/admin/pacware/status",
    );
    expect(status.status).toBe(200);
    expect(status.body.availability.status).toBe("disabled");

    const imp = await request(makeApp())
      .post("/resupply-api/admin/pacware/import/patients")
      .send({ csv: "pacware_id\nPW1", mode: "preview" });
    expect(imp.status).toBe(503);

    const roster = await request(makeApp()).get(
      "/resupply-api/admin/pacware/export/patients.csv",
    );
    expect(roster.status).toBe(503);

    const resupply = await request(makeApp()).get(
      "/resupply-api/admin/pacware/export/resupply-due.csv",
    );
    expect(resupply.status).toBe(503);
  });
});

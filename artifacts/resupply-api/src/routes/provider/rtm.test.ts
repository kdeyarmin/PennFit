// Route tests for the provider RTM dashboard (/api/provider/patients*).
//
// The PHI-safety properties under test:
//   * provider scoping — every read filters by the signed-in provider's
//     providerId; a patient not linked to the provider is a 404.
//   * MFA gate — the routes sit behind requireProviderMfaEnrolled.
//   * orgId threading — the routes read req.orgId (threaded by
//     attachProviderOrgId, host-resolved), and fail CLOSED (500) when it
//     is missing rather than widening to all tenants.
//
// We mock the provider gate + the org-id attacher + the org-scoped DB so
// the route's own scoping/threading logic is exercised without a live DB.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express, type RequestHandler } from "express";
import request from "supertest";

const PROVIDER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OWNED_PATIENT = "33333333-3333-4333-8333-333333333333";
const OTHER_PATIENT = "44444444-4444-4444-8444-444444444444";

// ── Mock the provider gate + org-id attacher ──────────────────────
// `requireProvider` attaches req.providerAccount; the MFA gate is a
// pass/deny toggle; attachProviderOrgId pins req.orgId (toggle-able to
// simulate a missing tenant context).
const gateState = vi.hoisted(() => ({
  mfaEnrolled: true,
  orgId: "22222222-2222-4222-8222-222222222222" as string | undefined,
}));

vi.mock("../../middlewares/requireProvider", () => {
  const attachAccount: RequestHandler = (req, _res, next) => {
    req.providerAccount = {
      id: "acct-1",
      providerId: "11111111-1111-4111-8111-111111111111",
      emailLower: "doc@example.com",
      status: "active",
      mfaEnrolledAt: "2026-01-01T00:00:00.000Z",
    };
    next();
  };
  const requireProviderMfaEnrolled: RequestHandler = (_req, res, next) => {
    if (!gateState.mfaEnrolled) {
      res.status(403).json({ error: "mfa_enrollment_required" });
      return;
    }
    next();
  };
  return {
    requireProvider: [attachAccount],
    requireProviderMfaEnrolled,
  };
});

vi.mock("./shared", () => {
  const providerPortalRateLimiter: RequestHandler = (_req, _res, next) =>
    next();
  const attachProviderOrgId: RequestHandler = (req, _res, next) => {
    req.orgId = gateState.orgId;
    next();
  };
  return { providerPortalRateLimiter, attachProviderOrgId };
});

// ── Mock the org-scoped DB ────────────────────────────────────────
// A tiny query-builder that records the table + the eq() filters applied
// and returns canned rows per table. Awaiting the builder resolves to
// { data, error }; maybeSingle() resolves the first row.
type Row = Record<string, unknown>;
const dbState = vi.hoisted(() => ({
  rowsByTable: {} as Record<string, Row[]>,
  calls: [] as Array<{
    table: string;
    eqs: Record<string, unknown>;
    ins: Record<string, unknown[]>;
  }>,
}));

function makeBuilder(table: string) {
  const eqs: Record<string, unknown> = {};
  const ins: Record<string, unknown[]> = {};
  const orders: Array<{ col: string; ascending: boolean }> = [];
  let limit: number | null = null;
  const builder: Record<string, unknown> = {};
  const passthrough = () => builder;
  for (const m of ["select", "gte", "lte", "range"]) {
    builder[m] = passthrough;
  }
  builder.order = (col: string, opts?: { ascending?: boolean }) => {
    orders.push({ col, ascending: opts?.ascending !== false });
    return builder;
  };
  builder.limit = (n: number) => {
    limit = n;
    return builder;
  };
  builder.eq = (col: string, val: unknown) => {
    eqs[col] = val;
    return builder;
  };
  builder.in = (col: string, vals: unknown[]) => {
    ins[col] = vals;
    return builder;
  };
  const resolveRows = (): Row[] => {
    dbState.calls.push({ table, eqs: { ...eqs }, ins: { ...ins } });
    let rows = dbState.rowsByTable[table] ?? [];
    // Honor the provider_id + patient_id eq() filters so the test sees
    // the route's scoping reflected in what comes back.
    if ("provider_id" in eqs) {
      rows = rows.filter((r) => r.provider_id === eqs.provider_id);
    }
    if ("patient_id" in eqs) {
      rows = rows.filter(
        (r) => r.patient_id === eqs.patient_id || r.id === eqs.patient_id,
      );
    }
    if ("id" in eqs) rows = rows.filter((r) => r.id === eqs.id);
    // Honor .in() filters (the roster restricts patients/nights to the
    // provider's own ids).
    for (const [col, vals] of Object.entries(ins)) {
      rows = rows.filter((r) => vals.includes(r[col]));
    }
    for (const { col, ascending } of orders) {
      rows = [...rows].sort((a, b) => {
        const av = a[col];
        const bv = b[col];
        if (av === bv) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        const cmp = av < bv ? -1 : 1;
        return ascending ? cmp : -cmp;
      });
    }
    if (limit != null) rows = rows.slice(0, limit);
    return rows;
  };
  builder.maybeSingle = async () => {
    const rows = resolveRows();
    return { data: rows[0] ?? null, error: null };
  };
  builder.then = (resolve: (v: { data: Row[]; error: null }) => unknown) =>
    resolve({ data: resolveRows(), error: null });
  return builder;
}

vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: () => ({
    from: (table: string) => makeBuilder(table),
  }),
}));

vi.mock("../../lib/company-info", () => ({
  getDocumentSupplierName: async () => "Test DME Supplier",
}));

import rtmRouter from "./rtm";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(rtmRouter);
  return app;
}

beforeEach(() => {
  gateState.mfaEnrolled = true;
  gateState.orgId = ORG_ID;
  dbState.calls = [];
  dbState.rowsByTable = {
    prescriptions: [
      { provider_id: PROVIDER_ID, patient_id: OWNED_PATIENT },
      // A different provider's prescription — must never surface.
      { provider_id: "other-provider", patient_id: OTHER_PATIENT },
    ],
    patients: [
      {
        id: OWNED_PATIENT,
        legal_first_name: "Ada",
        legal_last_name: "Lovelace",
        date_of_birth: "1950-12-10",
        status: "active",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: OTHER_PATIENT,
        legal_first_name: "Grace",
        legal_last_name: "Hopper",
        date_of_birth: "1955-01-01",
        status: "active",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    patient_therapy_nights: [
      {
        patient_id: OWNED_PATIENT,
        night_date: "2026-06-20",
        source: "resmed_airview",
        usage_minutes: 360,
        ahi: 3.1,
        leak_rate_l_min: 12,
      },
      {
        patient_id: OTHER_PATIENT,
        night_date: "2026-06-20",
        source: "resmed_airview",
        usage_minutes: 360,
        ahi: 3.1,
        leak_rate_l_min: 12,
      },
    ],
  };
});

describe("GET /api/provider/patients (roster)", () => {
  it("returns ONLY the signed-in provider's patients", async () => {
    const res = await request(makeApp()).get("/api/provider/patients");
    expect(res.status).toBe(200);
    expect(res.body.patients).toHaveLength(1);
    expect(res.body.patients[0].patientId).toBe(OWNED_PATIENT);
    expect(res.body.patients[0].patientName).toBe("Lovelace, Ada");
    // The provider_id filter was applied on the prescriptions read.
    const rxCall = dbState.calls.find((c) => c.table === "prescriptions");
    expect(rxCall?.eqs.provider_id).toBe(PROVIDER_ID);
  });

  it("403s when MFA is not enrolled", async () => {
    gateState.mfaEnrolled = false;
    const res = await request(makeApp()).get("/api/provider/patients");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("mfa_enrollment_required");
  });

  it("fails CLOSED (500) when no tenant context is resolved", async () => {
    gateState.orgId = undefined;
    const res = await request(makeApp()).get("/api/provider/patients");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("tenant_context_missing");
  });

  it("returns an empty roster when the provider has no patients", async () => {
    dbState.rowsByTable.prescriptions = [];
    const res = await request(makeApp()).get("/api/provider/patients");
    expect(res.status).toBe(200);
    expect(res.body.patients).toEqual([]);
  });

  it("chunks the .in() id lists and drops NO patient for a >chunk-size panel", async () => {
    // A panel larger than the 200-id chunk: every patient must come back
    // (no global .limit(20_000) truncation) and every .in() list must be
    // bounded so PostgREST never sees a URI-too-long id list.
    const PANEL = 250;
    const pad = (n: number) => n.toString().padStart(4, "0");
    const ids = Array.from(
      { length: PANEL },
      (_, i) => `99999999-9999-4999-8999-0000000${pad(i)}`,
    );
    dbState.rowsByTable.prescriptions = ids.map((id) => ({
      provider_id: PROVIDER_ID,
      patient_id: id,
    }));
    dbState.rowsByTable.patients = ids.map((id, i) => ({
      id,
      legal_first_name: `First${i}`,
      legal_last_name: `Last${i}`,
      date_of_birth: "1950-01-01",
      status: "active",
      created_at: "2026-01-01T00:00:00.000Z",
    }));
    dbState.rowsByTable.patient_therapy_nights = ids.map((id) => ({
      patient_id: id,
      night_date: "2026-06-20",
      source: "resmed_airview",
      usage_minutes: 360,
      ahi: 3.1,
      leak_rate_l_min: 12,
    }));

    const res = await request(makeApp()).get("/api/provider/patients");
    expect(res.status).toBe(200);
    // Not truncated: every patient is present and uniquely.
    expect(res.body.patients).toHaveLength(PANEL);
    expect(
      new Set(res.body.patients.map((p: { patientId: string }) => p.patientId))
        .size,
    ).toBe(PANEL);

    // Every .in("id", …) on patients was chunked to ≤200 and together
    // covered the whole panel exactly once.
    const patientInLists = dbState.calls
      .filter((c) => c.table === "patients" && Array.isArray(c.ins.id))
      .map((c) => c.ins.id as string[]);
    expect(patientInLists.length).toBeGreaterThan(1);
    for (const list of patientInLists) {
      expect(list.length).toBeLessThanOrEqual(200);
    }
    expect(patientInLists.flat().sort()).toEqual([...ids].sort());
  });

  it("returns the earliest therapy night as setupDate for every patient in a large panel", async () => {
    const PANEL = 250;
    const pad = (n: number) => n.toString().padStart(4, "0");
    const ids = Array.from(
      { length: PANEL },
      (_, i) => `99999999-9999-4999-8999-0000000${pad(i)}`,
    );
    dbState.rowsByTable.prescriptions = ids.map((id) => ({
      provider_id: PROVIDER_ID,
      patient_id: id,
    }));
    dbState.rowsByTable.patients = ids.map((id, i) => ({
      id,
      legal_first_name: `First${i}`,
      legal_last_name: `Last${i}`,
      date_of_birth: "1950-01-01",
      status: "active",
      created_at: "2026-01-01T00:00:00.000Z",
    }));
    // Each patient has multiple nights; setupDate must be the earliest.
    // Patient index 249 is the regression case: a truncated chunk read used
    // to drop later patients and leave setupDate null.
    dbState.rowsByTable.patient_therapy_nights = ids.flatMap((id, i) => {
      const setupDay = String(10 + (i % 20)).padStart(2, "0");
      const laterDay = String(Number(setupDay) + 3).padStart(2, "0");
      return [
        {
          patient_id: id,
          night_date: `2026-06-${setupDay}`,
          source: "resmed_airview",
          usage_minutes: 360,
          ahi: 3.1,
          leak_rate_l_min: 12,
        },
        {
          patient_id: id,
          night_date: `2026-06-${laterDay}`,
          source: "resmed_airview",
          usage_minutes: 300,
          ahi: 2.5,
          leak_rate_l_min: 10,
        },
      ];
    });

    const res = await request(makeApp()).get("/api/provider/patients");
    expect(res.status).toBe(200);
    expect(res.body.patients).toHaveLength(PANEL);

    const byId = new Map(
      res.body.patients.map((p: { patientId: string; setupDate: string }) => [
        p.patientId,
        p.setupDate,
      ]),
    );
    for (let i = 0; i < PANEL; i++) {
      const id = ids[i];
      const setupDay = String(10 + (i % 20)).padStart(2, "0");
      expect(byId.get(id)).toBe(`2026-06-${setupDay}`);
    }

    const lastPatient = ids[PANEL - 1];
    expect(byId.get(lastPatient)).not.toBeNull();
  });
});

describe("GET /api/provider/patients/:id (detail)", () => {
  it("returns the detail for one of the provider's own patients", async () => {
    const res = await request(makeApp()).get(
      `/api/provider/patients/${OWNED_PATIENT}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.patientId).toBe(OWNED_PATIENT);
    expect(res.body.snapshot.hasData).toBe(true);
  });

  it("404s for a patient the provider does NOT prescribe for", async () => {
    const res = await request(makeApp()).get(
      `/api/provider/patients/${OTHER_PATIENT}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("fails CLOSED (500) when no tenant context is resolved", async () => {
    gateState.orgId = undefined;
    const res = await request(makeApp()).get(
      `/api/provider/patients/${OWNED_PATIENT}`,
    );
    expect(res.status).toBe(500);
  });

  it("403s when MFA is not enrolled", async () => {
    gateState.mfaEnrolled = false;
    const res = await request(makeApp()).get(
      `/api/provider/patients/${OWNED_PATIENT}`,
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /api/provider/patients/:id/attestation.pdf", () => {
  it("streams a PDF for the provider's own patient", async () => {
    const res = await request(makeApp()).get(
      `/api/provider/patients/${OWNED_PATIENT}/attestation.pdf`,
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
  });

  it("404s for a patient the provider does NOT prescribe for", async () => {
    const res = await request(makeApp()).get(
      `/api/provider/patients/${OTHER_PATIENT}/attestation.pdf`,
    );
    expect(res.status).toBe(404);
  });

  it("422s when the patient has no therapy nights", async () => {
    dbState.rowsByTable.patient_therapy_nights = [];
    const res = await request(makeApp()).get(
      `/api/provider/patients/${OWNED_PATIENT}/attestation.pdf`,
    );
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("no_therapy_data");
  });
});

// Tests for the admin fit-request queue.
//
// The behaviour worth pinning hardest is the PATCH's field semantics.
// A CSR moves a request through new → contacted → in_progress → closed
// far more often than they edit the note, and the first version of this
// route folded an OMITTED `csrNote` into `null` before the handler's
// `!== undefined` check — so every status change silently deleted the
// note the CSR had written. Data loss with no error and no trace.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const db = vi.hoisted(() => ({
  /** Every update the route attempts, so a test can assert the payload. */
  updates: [] as Array<Record<string, unknown>>,
  /** What the pre-write `contacted_at` read returns. */
  existing: { contacted_at: null as string | null },
  row: {
    id: "55555555-5555-4555-8555-555555555555",
    status: "contacted",
    csr_note: "called, left voicemail",
    contacted_at: null as string | null,
    contacted_by: null as string | null,
    closed_at: null as string | null,
    updated_at: "2026-08-24T00:00:00.000Z",
  },
}));

vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) {
        chain[m] = () => chain;
      }
      chain.maybeSingle = async () => ({ data: db.existing, error: null });
      chain.update = (payload: Record<string, unknown>) => {
        db.updates.push(payload);
        const after: Record<string, unknown> = {
          ...chain,
          maybeSingle: async () => ({ data: db.row, error: null }),
        };
        for (const m of ["select", "eq", "order", "limit"]) {
          after[m] = () => after;
        }
        return after;
      };
      return chain;
    },
  }),
}));

vi.mock("../../middlewares/requireAdmin", () => ({
  requirePermission: () => (req: Request, _res: unknown, next: () => void) => {
    (req as unknown as { orgId: string; adminEmail: string }).orgId =
      "00000000-0000-4000-8000-000000000000";
    (req as unknown as { adminEmail: string }).adminEmail = "csr@example.com";
    next();
  },
}));

vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

import fitterRequestsRouter from "./fitter-requests";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(fitterRequestsRouter);
  return app;
}

const ID = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  db.updates = [];
  db.existing = { contacted_at: null };
});

describe("PATCH /admin/fitter-requests/:id — a status change must not eat the note", () => {
  it("leaves csr_note ALONE on a status-only update", async () => {
    const res = await request(makeApp())
      .patch(`/admin/fitter-requests/${ID}`)
      .send({ status: "contacted" });
    expect(res.status).toBe(200);
    expect(db.updates).toHaveLength(1);
    // The whole point: the column must not appear in the update at all.
    expect(db.updates[0]).not.toHaveProperty("csr_note");
  });

  it("clears the note only on an EXPLICIT null", async () => {
    await request(makeApp())
      .patch(`/admin/fitter-requests/${ID}`)
      .send({ csrNote: null });
    expect(db.updates[0]).toHaveProperty("csr_note", null);
  });

  it("clears the note on an explicit empty string", async () => {
    await request(makeApp())
      .patch(`/admin/fitter-requests/${ID}`)
      .send({ csrNote: "   " });
    expect(db.updates[0]).toHaveProperty("csr_note", null);
  });

  it("writes a real note", async () => {
    await request(makeApp())
      .patch(`/admin/fitter-requests/${ID}`)
      .send({ csrNote: "verified benefits, awaiting Rx" });
    expect(db.updates[0]).toHaveProperty(
      "csr_note",
      "verified benefits, awaiting Rx",
    );
  });

  it("rejects a body that asks for nothing at all", async () => {
    const res = await request(makeApp())
      .patch(`/admin/fitter-requests/${ID}`)
      .send({});
    expect(res.status).toBe(400);
    expect(db.updates).toHaveLength(0);
  });
});

describe("PATCH /admin/fitter-requests/:id — lifecycle stamps", () => {
  it("records who first reached the patient", async () => {
    await request(makeApp())
      .patch(`/admin/fitter-requests/${ID}`)
      .send({ status: "contacted" });
    expect(db.updates[0]).toHaveProperty("contacted_by", "csr@example.com");
    expect(db.updates[0]).toHaveProperty("contacted_at");
  });

  it("does NOT rewrite contacted_at on a later transition", async () => {
    // "Who first reached this patient" has to survive a re-open, so the
    // stamp is written once and then left alone.
    db.existing = { contacted_at: "2026-08-01T00:00:00.000Z" };
    await request(makeApp())
      .patch(`/admin/fitter-requests/${ID}`)
      .send({ status: "in_progress" });
    expect(db.updates[0]).not.toHaveProperty("contacted_at");
    expect(db.updates[0]).not.toHaveProperty("contacted_by");
  });

  it("stamps closed_at on close and clears it on re-open", async () => {
    await request(makeApp())
      .patch(`/admin/fitter-requests/${ID}`)
      .send({ status: "closed" });
    expect(db.updates[0]!.closed_at).toBeTruthy();

    db.updates = [];
    await request(makeApp())
      .patch(`/admin/fitter-requests/${ID}`)
      .send({ status: "new" });
    expect(db.updates[0]).toHaveProperty("closed_at", null);
  });

  it("rejects a malformed id", async () => {
    const res = await request(makeApp())
      .patch("/admin/fitter-requests/not-a-uuid")
      .send({ status: "closed" });
    expect(res.status).toBe(400);
  });
});

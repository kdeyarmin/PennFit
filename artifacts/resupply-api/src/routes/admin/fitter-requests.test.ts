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
      chain.is = () => chain;
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
    // Two updates now: the first-contact claim, then the patch. Neither
    // may touch the note.
    for (const u of db.updates) expect(u).not.toHaveProperty("csr_note");
  });

  it("clears the note only on an EXPLICIT null", async () => {
    await request(makeApp())
      .patch(`/admin/fitter-requests/${ID}`)
      .send({ csrNote: null });
    expect(db.updates.at(-1)).toHaveProperty("csr_note", null);
  });

  it("clears the note on an explicit empty string", async () => {
    await request(makeApp())
      .patch(`/admin/fitter-requests/${ID}`)
      .send({ csrNote: "   " });
    expect(db.updates.at(-1)).toHaveProperty("csr_note", null);
  });

  it("writes a real note", async () => {
    await request(makeApp())
      .patch(`/admin/fitter-requests/${ID}`)
      .send({ csrNote: "verified benefits, awaiting Rx" });
    expect(db.updates.at(-1)).toHaveProperty(
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
  it("claims the first contact ATOMICALLY, in its own guarded update", async () => {
    // Two CSRs can open the same request. A read-then-write here let both
    // observe `contacted_at` as null and both write, so the LAST one won
    // and the record showed the wrong person — the exact fact this column
    // exists to preserve. The claim is now a separate update guarded on
    // `contacted_at IS NULL`, so the database arbitrates.
    await request(makeApp())
      .patch(`/admin/fitter-requests/${ID}`)
      .send({ status: "contacted" });
    expect(db.updates).toHaveLength(2);
    const [claim, patch] = db.updates;
    expect(claim).toHaveProperty("contacted_by", "csr@example.com");
    expect(claim).toHaveProperty("contacted_at");
    // The main patch carries the status and NOT the provenance stamp —
    // otherwise it would overwrite whatever the claim decided.
    expect(patch).toHaveProperty("status", "contacted");
    expect(patch).not.toHaveProperty("contacted_at");
    expect(patch).not.toHaveProperty("contacted_by");
  });

  it("does not attempt a claim on a transition that is not a first contact", async () => {
    await request(makeApp())
      .patch(`/admin/fitter-requests/${ID}`)
      .send({ status: "closed" });
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]).not.toHaveProperty("contacted_at");
  });

  it("stamps closed_at on close and clears it on re-open", async () => {
    await request(makeApp())
      .patch(`/admin/fitter-requests/${ID}`)
      .send({ status: "closed" });
    expect(db.updates.at(-1)!.closed_at).toBeTruthy();

    db.updates = [];
    await request(makeApp())
      .patch(`/admin/fitter-requests/${ID}`)
      .send({ status: "new" });
    expect(db.updates.at(-1)).toHaveProperty("closed_at", null);
  });

  it("rejects a malformed id", async () => {
    const res = await request(makeApp())
      .patch("/admin/fitter-requests/not-a-uuid")
      .send({ status: "closed" });
    expect(res.status).toBe(400);
  });
});

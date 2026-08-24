// Closing a fit request with an outcome, and what that outcome writes.
//
// WHY THIS MATTERS BEYOND THE QUEUE
// ---------------------------------
// Migration 0518 removed the fitter's cash-pay checkout, which was the
// only writer of `fit_sessions.dispensed_at` and `ordered_mask_model_id`.
// Three things read those columns: the outcomes dashboard's dispense
// rate, its accepted-vs-overridden split, and the re-fit campaign's
// discontinued-mask branch. Leaving them unwritten recreates exactly the
// bug `lib/fitting/order-link.ts` was written to fix — "the outcome
// dashboard reported a dispense rate of zero forever".
//
// A CSR closing a request as `fulfilled` is now that writer, so these
// tests pin both halves: that the outcome is recorded, and that ONLY
// `fulfilled` — the one outcome asserting the patient actually has a
// mask — reaches the fitting.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const db = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  existing: { contacted_at: null as string | null },
  row: {
    id: "55555555-5555-4555-8555-555555555555",
    status: "closed",
    csr_note: null as string | null,
    contacted_at: null as string | null,
    contacted_by: null as string | null,
    closed_at: "2026-08-24T00:00:00.000Z" as string | null,
    closed_outcome: "fulfilled" as string | null,
    fit_session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as string | null,
    recommended_mask_id: "resmed-airfit-f20" as string | null,
    updated_at: "2026-08-24T00:00:00.000Z",
  },
}));

const stamp = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit", "is"]) {
        chain[m] = () => chain;
      }
      chain.maybeSingle = async () => ({ data: db.existing, error: null });
      chain.update = (payload: Record<string, unknown>) => {
        db.updates.push(payload);
        const after: Record<string, unknown> = {
          maybeSingle: async () => ({ data: db.row, error: null }),
        };
        for (const m of ["select", "eq", "order", "limit", "is"]) {
          after[m] = () => after;
        }
        return after;
      };
      return chain;
    },
  }),
}));

vi.mock("../../lib/fitting/order-link", () => ({
  markFitSessionDispensedById: async (orgId: string, input: unknown) => {
    stamp.calls.push({ orgId, input });
    return { stamped: true };
  },
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
const patch = (body: Record<string, unknown>) =>
  request(makeApp()).patch(`/admin/fitter-requests/${ID}`).send(body);

beforeEach(() => {
  db.updates = [];
  db.existing = { contacted_at: null };
  stamp.calls = [];
  db.row = {
    ...db.row,
    status: "closed",
    closed_outcome: "fulfilled",
    fit_session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    recommended_mask_id: "resmed-airfit-f20",
  };
});

describe("PATCH /admin/fitter-requests/:id — recording the outcome", () => {
  it("records the outcome the CSR chose when closing", async () => {
    const res = await patch({ status: "closed", closedOutcome: "fulfilled" });
    expect(res.status).toBe(200);
    expect(db.updates.at(-1)).toHaveProperty("closed_outcome", "fulfilled");
    expect(res.body.closedOutcome).toBe("fulfilled");
  });

  it("leaves the outcome UNRECORDED when a close does not state one", async () => {
    // NULL reads honestly as "closed, we didn't say how". Defaulting to
    // 'fulfilled' would inflate the dispense rate with every tidy-up.
    await patch({ status: "closed" });
    expect(db.updates.at(-1)).not.toHaveProperty("closed_outcome");
  });

  it("accepts an outcome on its own, so a CSR can record it after the fact", async () => {
    const res = await patch({ closedOutcome: "not_proceeding" });
    expect(res.status).toBe(200);
    expect(db.updates.at(-1)).toHaveProperty(
      "closed_outcome",
      "not_proceeding",
    );
    // Status-free patch: the close timestamp is not re-stamped.
    expect(db.updates.at(-1)).not.toHaveProperty("closed_at");
  });

  it("clears the outcome when the request is re-opened", async () => {
    // A request being worked again has no outcome yet, and a stale
    // 'fulfilled' would keep counting a dispense for a live fitting.
    await patch({ status: "in_progress" });
    expect(db.updates.at(-1)).toHaveProperty("closed_outcome", null);
    expect(db.updates.at(-1)).toHaveProperty("closed_at", null);
  });

  it("rejects an outcome that is not one of the four", async () => {
    const res = await patch({ status: "closed", closedOutcome: "maybe" });
    expect(res.status).toBe(400);
    expect(db.updates).toHaveLength(0);
  });

  it("still rejects a body that asks for nothing", async () => {
    const res = await patch({});
    expect(res.status).toBe(400);
  });
});

describe("PATCH /admin/fitter-requests/:id — the dispense stamp", () => {
  it("stamps the linked fitting when the request closes as fulfilled", async () => {
    await patch({ status: "closed", closedOutcome: "fulfilled" });
    expect(stamp.calls).toHaveLength(1);
    expect(stamp.calls[0]).toMatchObject({
      orgId: "00000000-0000-4000-8000-000000000000",
      input: {
        fitSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        // The mask the PATIENT chose, which may be an alternative rather
        // than the engine's top pick — that difference is the whole
        // value of the accepted-vs-overridden metric.
        orderedMaskSlug: "resmed-airfit-f20",
      },
    });
  });

  it("does NOT stamp for any other outcome", async () => {
    for (const outcome of ["not_proceeding", "unreachable", "duplicate"]) {
      stamp.calls = [];
      db.row = { ...db.row, closed_outcome: outcome };
      await patch({ status: "closed", closedOutcome: outcome });
      expect(stamp.calls, `outcome ${outcome} must not dispense`).toHaveLength(
        0,
      );
    }
  });

  it("does not stamp a close with no outcome recorded", async () => {
    db.row = { ...db.row, closed_outcome: null };
    await patch({ status: "closed" });
    expect(stamp.calls).toHaveLength(0);
  });

  it("does not stamp when the request is not closed", async () => {
    db.row = { ...db.row, status: "in_progress", closed_outcome: null };
    await patch({ status: "in_progress" });
    expect(stamp.calls).toHaveLength(0);
  });

  it("skips the stamp when no fitting is linked, without failing the close", async () => {
    // A callback request carries no fit session — the patient asked for
    // a person before choosing anything. Closing it is still valid work.
    db.row = { ...db.row, fit_session_id: null };
    const res = await patch({ status: "closed", closedOutcome: "fulfilled" });
    expect(res.status).toBe(200);
    expect(stamp.calls).toHaveLength(0);
  });

  it("still closes the request when the attribution write fails", async () => {
    // Attribution is a reporting nicety; the close is the CSR's actual
    // work and must never be lost to it.
    const mod = await import("../../lib/fitting/order-link");
    vi.spyOn(mod, "markFitSessionDispensedById").mockRejectedValueOnce(
      new Error("supabase down"),
    );
    const res = await patch({ status: "closed", closedOutcome: "fulfilled" });
    expect(res.status).toBe(200);
    expect(res.body.closedOutcome).toBe("fulfilled");
  });
});

// Tests for the fitter follow-up alert worklist.
//
// Three things this route must never get wrong:
//
//   * `resolved` is not settable by a human. It is the sweep's assertion
//     that the patient actually acted, and it is the only measure of
//     whether these follow-ups work — a CSR who could set it by hand
//     would make the number meaningless.
//   * a status-only PATCH must not eat the staff note (the same
//     `undefined`-vs-null trap that once silently deleted notes on the
//     fit-request queue next door).
//   * a hydrate failure degrades to an un-hydrated row rather than
//     500-ing the page: an alert without its contact still tells a CSR
//     somebody went quiet.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const ALERT_ID = "66666666-6666-4666-8666-666666666666";
const INVITE_ID = "77777777-7777-4777-8777-777777777777";

const db = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  /** Tables the route read, in order. */
  selects: [] as string[],
  /** Every `.eq(column, value)` the route applied, in order. */
  eqFilters: [] as Array<[string, unknown]>,
  /** How many `.range(...)` calls it made — paging, not one big limit. */
  rangeCalls: 0,
  /** When set, reads of this table reject — the degrade path. */
  failTable: null as string | null,
  alert: {
    id: "66666666-6666-4666-8666-666666666666",
    alert_type: "fit_no_request",
    severity: "high",
    status: "open",
    fitter_invite_id: "77777777-7777-4777-8777-777777777777",
    fit_request_id: null,
    fit_session_id: null,
    patient_id: null,
    detail: { days_since_fitting: 6 },
    nudge_count: 1,
    last_nudge_at: "2026-06-07T00:00:00.000Z",
    last_nudge_channel: "email",
    resolved_at: null,
    resolved_reason: null,
    dismissed_at: null,
    dismissed_by_email: null,
    staff_note: "left a voicemail",
    created_at: "2026-06-06T00:00:00.000Z",
    updated_at: "2026-06-07T00:00:00.000Z",
  } as Record<string, unknown>,
  invite: {
    id: "77777777-7777-4777-8777-777777777777",
    status: "completed",
    channel: "email",
    recipient_name: "Jordan Avery",
    recipient_email: "jordan@example.com",
    recipient_phone_e164: "+12155550137",
    recommended_mask_name: "ResMed AirFit P30i",
    sent_at: "2026-05-28T00:00:00.000Z",
    completed_at: "2026-06-04T00:00:00.000Z",
    expires_at: "2026-06-27T00:00:00.000Z",
  } as Record<string, unknown>,
}));

vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      // Every filter/paging verb the route can chain. `range` and `neq`
      // matter: the list now reads one bounded page PER SEVERITY BAND
      // and pages the open-alert counts, rather than taking one
      // `.limit()` and re-sorting in JS.
      const passthrough = [
        "select",
        "eq",
        "neq",
        "in",
        "order",
        "limit",
        "not",
        "is",
      ];
      const filters: Array<[string, unknown]> = [];
      let rangeFrom = 0;

      const rows = () => {
        db.selects.push(table);
        if (db.failTable === table) {
          return Promise.reject(new Error("postgrest exploded"));
        }
        // A paged read past the first page is empty — otherwise the
        // paging loops would never terminate.
        if (rangeFrom > 0) return Promise.resolve({ data: [], error: null });
        if (table === "fitter_followup_alerts") {
          // Honour a severity band filter so the banded reads return the
          // row exactly once, in its own band.
          const band = filters.find(([c]) => c === "severity")?.[1];
          if (band !== undefined && band !== db.alert.severity) {
            return Promise.resolve({ data: [], error: null });
          }
          return Promise.resolve({ data: [db.alert], error: null });
        }
        if (table === "fitter_invites") {
          return Promise.resolve({ data: [db.invite], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      };

      for (const m of passthrough) {
        chain[m] = (...args: unknown[]) => {
          if (m === "eq") {
            filters.push([String(args[0]), args[1]]);
            db.eqFilters.push([String(args[0]), args[1]]);
          }
          return chain;
        };
      }
      chain.range = (from: number) => {
        rangeFrom = from;
        db.rangeCalls += 1;
        return chain;
      };
      chain.then = (
        onFulfilled: (v: unknown) => unknown,
        onRejected?: (e: unknown) => unknown,
      ) => rows().then(onFulfilled, onRejected);
      chain.maybeSingle = () =>
        rows().then((r) => {
          const data = (r as { data: unknown[] }).data;
          return { data: data[0] ?? null, error: null };
        });
      chain.update = (payload: Record<string, unknown>) => {
        db.updates.push(payload);
        const after: Record<string, unknown> = { ...chain };
        for (const m of passthrough) after[m] = () => after;
        after.range = () => after;
        after.maybeSingle = async () => ({
          data: { ...db.alert, ...payload },
          error: null,
        });
        return after;
      };
      return chain;
    },
  }),
}));

vi.mock("../../middlewares/requireAdmin", () => ({
  requirePermission: () => (req: Request, _res: unknown, next: () => void) => {
    (req as unknown as { orgId: string }).orgId =
      "00000000-0000-4000-8000-000000000000";
    (req as unknown as { adminEmail: string }).adminEmail = "csr@example.com";
    next();
  },
}));

vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

import alertsRouter from "./fitter-followup-alerts";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(alertsRouter);
  return app;
}

beforeEach(() => {
  db.updates = [];
  db.selects = [];
  db.failTable = null;
  db.alert.status = "open";
  db.alert.staff_note = "left a voicemail";
  db.invite.channel = "email";
  db.eqFilters = [];
  db.rangeCalls = 0;
});

describe("GET /admin/fitter-followup-alerts", () => {
  it("joins the contact in from the invite rather than storing it", async () => {
    const res = await request(makeApp()).get("/admin/fitter-followup-alerts");
    expect(res.status).toBe(200);
    const [row] = res.body.alerts as Array<Record<string, unknown>>;
    expect(row.contact).toMatchObject({
      name: "Jordan Avery",
      email: "jordan@example.com",
      phone: "+12155550137",
    });
    expect(row.recommendedMaskName).toBe("ResMed AirFit P30i");
    // The alert table itself was read, and so was the invite it points at.
    expect(db.selects).toContain("fitter_invites");
  });

  it("reports OPEN counts whatever the caller filtered by", async () => {
    const res = await request(makeApp()).get(
      "/admin/fitter-followup-alerts?status=dismissed",
    );
    expect(res.status).toBe(200);
    // A badge whose meaning changed with the filter would be unreadable,
    // so the counts query is always scoped to open.
    expect(res.body.counts.fit_no_request).toBe(1);
    expect(res.body.openTotal).toBe(1);
    expect(res.body.openHigh).toBe(1);
  });

  it("does not label an in-office handover as an email preference", async () => {
    // A QR handed over at the counter picks no channel, and a COMPLETED
    // in-office invite still reaches this queue as `fit_no_request` —
    // that scan has no expiry filter. Defaulting it to "email" would
    // tell a CSR the patient asked to be emailed when nobody chose.
    db.invite.channel = "in_office";
    const res = await request(makeApp()).get("/admin/fitter-followup-alerts");
    const [row] = res.body.alerts as Array<Record<string, unknown>>;
    expect((row.contact as Record<string, unknown>).preferredMethod).toBe(
      "in_office",
    );
    db.invite.channel = "email";
  });

  it("maps an SMS invite to a text preference", async () => {
    db.invite.channel = "sms";
    const res = await request(makeApp()).get("/admin/fitter-followup-alerts");
    const [row] = res.body.alerts as Array<Record<string, unknown>>;
    expect((row.contact as Record<string, unknown>).preferredMethod).toBe(
      "text",
    );
    db.invite.channel = "email";
  });

  it("ranks severity in the DATABASE, not after the limit truncates", async () => {
    // `severity` is text, so ordering by it is alphabetical and useless;
    // ordering by age and re-sorting the page in JS is worse, because
    // the database hands back the oldest N regardless of severity. With
    // more matches than the limit, a brand-new high-severity row — a
    // finished fitting nobody has acted on — would be dropped before
    // the route ever saw it, while older medium ones filled the page.
    const res = await request(makeApp()).get("/admin/fitter-followup-alerts");
    expect(res.status).toBe(200);
    const bands = db.eqFilters
      .filter(([col]) => col === "severity")
      .map(([, val]) => val);
    expect(bands).toEqual(["high", "medium", "low"]);
  });

  it("pages the open-alert counts rather than trusting one big limit", async () => {
    // `.limit(2000)` is silently capped by PostgREST's configured
    // maximum, so the badges would under-report while presenting
    // themselves as complete — the one direction a "who is still
    // waiting" number must never be wrong in.
    await request(makeApp()).get("/admin/fitter-followup-alerts");
    expect(db.rangeCalls).toBeGreaterThan(0);
  });

  it("rejects an unknown status filter rather than silently widening", async () => {
    const res = await request(makeApp()).get(
      "/admin/fitter-followup-alerts?status=everything",
    );
    expect(res.status).toBe(400);
  });

  it("still renders when the contact hydrate fails", async () => {
    db.failTable = "fitter_invites";
    const res = await request(makeApp()).get("/admin/fitter-followup-alerts");
    expect(res.status).toBe(200);
    const [row] = res.body.alerts as Array<Record<string, unknown>>;
    expect(row.contact).toBeNull();
    expect(row.id).toBe(ALERT_ID);
  });
});

describe("PATCH /admin/fitter-followup-alerts/:id", () => {
  it("dismisses with an attributed timestamp", async () => {
    const res = await request(makeApp())
      .patch(`/admin/fitter-followup-alerts/${ALERT_ID}`)
      .send({ status: "dismissed" });
    expect(res.status).toBe(200);
    const patch = db.updates.at(-1)!;
    expect(patch.status).toBe("dismissed");
    expect(patch.dismissed_by_email).toBe("csr@example.com");
    expect(patch.dismissed_at).toEqual(expect.any(String));
  });

  it("leaves the note ALONE on a status-only update", async () => {
    await request(makeApp())
      .patch(`/admin/fitter-followup-alerts/${ALERT_ID}`)
      .send({ status: "dismissed" });
    expect(db.updates.at(-1)).not.toHaveProperty("staff_note");
  });

  it("clears the note only on an explicit null or empty string", async () => {
    await request(makeApp())
      .patch(`/admin/fitter-followup-alerts/${ALERT_ID}`)
      .send({ staffNote: "   " });
    expect(db.updates.at(-1)).toHaveProperty("staff_note", null);
  });

  it("refuses to let a human assert `resolved`", async () => {
    const res = await request(makeApp())
      .patch(`/admin/fitter-followup-alerts/${ALERT_ID}`)
      .send({ status: "resolved" });
    expect(res.status).toBe(400);
    expect(db.updates).toHaveLength(0);
  });

  it("clears the resolution when a dismissed alert is reopened", async () => {
    const res = await request(makeApp())
      .patch(`/admin/fitter-followup-alerts/${ALERT_ID}`)
      .send({ status: "open" });
    expect(res.status).toBe(200);
    const patch = db.updates.at(-1)!;
    expect(patch.status).toBe("open");
    expect(patch.dismissed_at).toBeNull();
    expect(patch.resolved_at).toBeNull();
    expect(patch.resolved_reason).toBeNull();
  });

  it("rejects a body that asks for nothing", async () => {
    const res = await request(makeApp())
      .patch(`/admin/fitter-followup-alerts/${ALERT_ID}`)
      .send({});
    expect(res.status).toBe(400);
    expect(db.updates).toHaveLength(0);
  });

  it("rejects a non-uuid id before touching the database", async () => {
    const res = await request(makeApp())
      .patch("/admin/fitter-followup-alerts/not-a-uuid")
      .send({ status: "dismissed" });
    expect(res.status).toBe(400);
    expect(db.updates).toHaveLength(0);
  });

  it("rejects unknown fields rather than ignoring them", async () => {
    const res = await request(makeApp())
      .patch(`/admin/fitter-followup-alerts/${ALERT_ID}`)
      .send({ severity: "low" });
    expect(res.status).toBe(400);
  });
});

describe("fixtures", () => {
  it("keeps the alert's invite id in sync with the mock invite row", () => {
    // Otherwise the hydrate assertions above would pass for the wrong
    // reason: the route looks the invite up BY id.
    expect(db.alert.fitter_invite_id).toBe(INVITE_ID);
    expect(db.invite.id).toBe(INVITE_ID);
  });
});

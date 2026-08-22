// Integration test for the multi-tenant video-visit reminder fan-out (G2).
//
// The fan-out unit test (`video-visit-reminders.fan-out.test.ts`) verifies
// the per-tenant flag gate and that the sweep walks every active tenant
// against mocks. This suite proves, on a REAL PostgREST surface, what the
// mock can't:
//
//   * each tenant's `video_visits` scan + claim runs scoped to that
//     tenant's `org_id`, and
//   * one tenant's due visit is NEVER reminded or claimed under another
//     tenant — the cross-tenant leak the fan-out must not introduce.
//
// It seeds TWO active orgs, each with one patient and one due "scheduled"
// visit (with the per-org telehealth + email-reminder flags ON), runs the
// real sweep, and asserts both patients are emailed AND each tenant's visit
// is stamped reminder_sent_at only under its own org.
//
// Skip-when-unconfigured: same env triad as the other worker integration
// tests. Twilio is left unconfigured so the deliverable channel is email
// only (SendGrid is mocked); the link HMAC key is set locally so token
// signing never throws.

import { randomUUID } from "node:crypto";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Mock SendGrid BEFORE importing the worker: the sweep's email channel
// resolves to our stub (so no real send), while Twilio stays unconfigured
// in CI → SMS unavailable → email is the only deliverable channel.
const sendEmailMock = vi.fn(
  async (..._args: unknown[]) => undefined as unknown,
);
vi.mock("@workspace/resupply-email", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/resupply-email")>();
  class EmailConfigError extends Error {}
  return {
    ...actual,
    createSendgridClient: () => ({ sendEmail: sendEmailMock }),
    EmailConfigError,
  };
});

import {
  __resetDbPoolForTests,
  getDbPool,
  getOrgScopedClient,
} from "@workspace/resupply-db";

import { runVideoVisitReminderSweep } from "./video-visit-reminders";

const skip =
  !process.env.DATABASE_URL ||
  !process.env.SUPABASE_URL ||
  !process.env.SUPABASE_SERVICE_ROLE_KEY;

const describeIfDb = skip ? describe.skip : describe;

// A known-good 32+ byte base64 key so signVideoVisitToken never throws.
const TEST_LINK_HMAC_KEY = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";

describeIfDb("video-visit-reminders fan-out (live db)", () => {
  const runTag = `vv-reminder-it-${Math.random().toString(36).slice(2, 10)}`;
  const orgAId = randomUUID();
  const orgBId = randomUUID();
  const patientAId = randomUUID();
  const patientBId = randomUUID();
  const visitAId = randomUUID();
  const visitBId = randomUUID();
  const emailA = `${runTag}+a@example.test`;
  const emailB = `${runTag}+b@example.test`;

  let migrationsReady = false;
  let priorHmacKey: string | undefined;

  async function seedOrg(orgId: string, slugSuffix: string): Promise<void> {
    const pool = getDbPool();
    await pool.query(
      `INSERT INTO resupply.organizations (id, slug, name, status)
       VALUES ($1, $2, $3, 'active')`,
      [orgId, `${runTag}-${slugSuffix}`, `Test Org ${slugSuffix}`],
    );
    // Per-tenant flags the sweep gates on. Explicit so the test never
    // depends on the seed org's defaults.
    for (const key of ["telehealth.video", "email.reminders"]) {
      await pool.query(
        `INSERT INTO resupply.feature_flags
           (org_id, key, enabled, description, category)
         VALUES ($1, $2, true, 'integration test', 'test')`,
        [orgId, key],
      );
    }
  }

  async function seedDueVisit(
    orgId: string,
    patientId: string,
    email: string,
    visitId: string,
  ): Promise<void> {
    const pool = getDbPool();
    await pool.query(
      `INSERT INTO resupply.patients
         (id, org_id, legal_first_name, legal_last_name, date_of_birth,
          email, timezone, status)
       VALUES ($1, $2, 'Test', 'Patient', '1970-01-01', $3,
               'America/New_York', 'active')`,
      [patientId, orgId, email],
    );
    // A "scheduled" visit starting in 30 min → inside the 60-min reminder
    // window, not yet reminded. invite_channel left null so the target
    // resolver falls through to the only deliverable channel (email).
    await pool.query(
      `INSERT INTO resupply.video_visits
         (id, org_id, patient_id, purpose, status, scheduled_at,
          link_version, reminder_sent_at)
       VALUES ($1, $2, $3, 'follow_up', 'scheduled', $4, 1, NULL)`,
      [
        visitId,
        orgId,
        patientId,
        new Date(Date.now() + 30 * 60_000).toISOString(),
      ],
    );
  }

  beforeAll(async () => {
    priorHmacKey = process.env.RESUPPLY_LINK_HMAC_KEY;
    process.env.RESUPPLY_LINK_HMAC_KEY = TEST_LINK_HMAC_KEY;
    try {
      await getDbPool().query(
        `SELECT org_id FROM resupply.video_visits LIMIT 0`,
      );
      await getDbPool().query(
        `SELECT org_id FROM resupply.feature_flags LIMIT 0`,
      );
      migrationsReady = true;
    } catch {
      migrationsReady = false;
    }
    if (migrationsReady) {
      await seedOrg(orgAId, "a");
      await seedOrg(orgBId, "b");
      await seedDueVisit(orgAId, patientAId, emailA, visitAId);
      await seedDueVisit(orgBId, patientBId, emailB, visitBId);
    }
  });

  beforeEach(() => sendEmailMock.mockClear());

  afterAll(async () => {
    if (migrationsReady) {
      const pool = getDbPool();
      const orgIds = [orgAId, orgBId];
      await pool.query(
        `DELETE FROM resupply.video_visits WHERE org_id = ANY($1)`,
        [orgIds],
      );
      await pool.query(`DELETE FROM resupply.patients WHERE org_id = ANY($1)`, [
        orgIds,
      ]);
      await pool.query(
        `DELETE FROM resupply.feature_flags WHERE org_id = ANY($1)`,
        [orgIds],
      );
      await pool.query(
        `DELETE FROM resupply.organizations WHERE id = ANY($1)`,
        [orgIds],
      );
    }
    if (priorHmacKey === undefined) delete process.env.RESUPPLY_LINK_HMAC_KEY;
    else process.env.RESUPPLY_LINK_HMAC_KEY = priorHmacKey;
    await __resetDbPoolForTests();
  });

  it("reminds both tenants' due visits with no cross-tenant leak", async (ctx) => {
    if (!migrationsReady) {
      ctx.skip();
      return;
    }

    const stats = await runVideoVisitReminderSweep(new Date());

    // Both seeded visits are due → at least our two reminders went out.
    expect(stats.sent).toBeGreaterThanOrEqual(2);
    expect(stats.errors).toBe(0);

    const ourSends = sendEmailMock.mock.calls
      .map((c) => (c[0] as { to?: string } | undefined)?.to)
      .filter(
        (to): to is string =>
          typeof to === "string" && to.startsWith(`${runTag}+`),
      );
    expect(ourSends).toEqual(expect.arrayContaining([emailA, emailB]));

    // Cross-tenant isolation — read each tenant's visits back through its
    // OWN org-scoped client. Org A's claim stamped only visit A; org A's
    // client must never see (or have stamped) org B's visit.
    const aClient = getOrgScopedClient(orgAId);
    const { data: aVisits, error: aErr } = await aClient
      .from("video_visits")
      .select("id, reminder_sent_at");
    expect(aErr).toBeNull();
    const aById = new Map(
      (aVisits ?? []).map(
        (r: { id: string; reminder_sent_at: string | null }) => [
          r.id,
          r.reminder_sent_at,
        ],
      ),
    );
    expect(aById.get(visitAId)).not.toBeNull();
    expect(aById.has(visitBId)).toBe(false);

    const bClient = getOrgScopedClient(orgBId);
    const { data: bVisits, error: bErr } = await bClient
      .from("video_visits")
      .select("id, reminder_sent_at");
    expect(bErr).toBeNull();
    const bById = new Map(
      (bVisits ?? []).map(
        (r: { id: string; reminder_sent_at: string | null }) => [
          r.id,
          r.reminder_sent_at,
        ],
      ),
    );
    expect(bById.get(visitBId)).not.toBeNull();
    expect(bById.has(visitAId)).toBe(false);
  });
});

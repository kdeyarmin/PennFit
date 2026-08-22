// Integration test for the multi-tenant maintenance-nudge fan-out (G2).
//
// The companion unit test (`maintenance-nudges.test.ts`) verifies, against
// the Supabase mock, that the sweep fans out across active tenants and
// no-ops when there are none. That mock can't catch what this suite does:
//
//   * that each tenant's roster walk + maintenance-log RPC + nudge insert
//     actually scope to that tenant's `org_id` on a REAL PostgREST surface
//     (the thing the fan-out exists to guarantee), and
//   * that one tenant's overdue patient is NEVER emailed or logged under
//     another tenant — the cross-tenant leak the fan-out must not introduce.
//
// It seeds TWO active orgs, each with one engaged patient carrying an
// overdue daily task, runs the real sweep, and asserts both patients are
// nudged AND each tenant's nudge log contains only its own patient.
//
// Skip-when-unconfigured contract: same env triad as
// invite-password-expiry-notify.integration.test.ts. When any of
// DATABASE_URL / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY is missing the
// whole suite skips so `pnpm -r test` stays green in lanes without a DB.
//
// Cleanup is surgical: every seeded row hangs off two per-run org ids and
// we DELETE only those in afterAll. We never truncate — other suites may
// be running in parallel.

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

// Mock SendGrid BEFORE importing the worker so the sweep's
// createSendgridClient resolves to our stub — we don't hit the real API or
// leak fake recipients. Supabase is NOT mocked: the sweep must exercise the
// real org-scoped PostgREST path for this suite to be meaningful.
const sendEmailMock = vi.fn(
  async (..._args: unknown[]) => undefined as unknown,
);
vi.mock("@workspace/resupply-email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/resupply-email")>()),
  createSendgridClient: () => ({ sendEmail: sendEmailMock }),
  DEFAULT_SENDGRID_FROM_EMAIL: "info@pennpaps.example",
}));

import {
  __resetDbPoolForTests,
  getDbPool,
  getOrgScopedClient,
} from "@workspace/resupply-db";

import { runMaintenanceNudgeSweep } from "./maintenance-nudges";

const skip =
  !process.env.DATABASE_URL ||
  !process.env.SUPABASE_URL ||
  !process.env.SUPABASE_SERVICE_ROLE_KEY;

const describeIfDb = skip ? describe.skip : describe;

// A daily task in the catalog — a 5-day-old completion is unambiguously
// overdue ("due_now"), so the seeded patient is both engaged and nudge-worthy.
const DAILY_TASK = "mask_cushion_wipe";
const FIVE_DAYS_MS = 5 * 86_400_000;

const FULL_CFG = {
  sendgridApiKey: "SG.integration-test",
  sendgridFromEmail: "info@pennpaps.example",
  sendgridFromName: "Penn Home Medical Supply",
  practiceName: "Penn Home Medical Supply",
  publicBaseUrl: "https://pennfit.example",
};

describeIfDb("maintenance-nudges fan-out (live db)", () => {
  const runTag = `maint-nudge-it-${Math.random().toString(36).slice(2, 10)}`;
  const orgAId = randomUUID();
  const orgBId = randomUUID();
  const patientAId = randomUUID();
  const patientBId = randomUUID();
  const emailA = `${runTag}+a@example.test`;
  const emailB = `${runTag}+b@example.test`;

  let migrationsReady = false;

  async function seedOrg(orgId: string, slugSuffix: string): Promise<void> {
    const pool = getDbPool();
    await pool.query(
      `INSERT INTO resupply.organizations (id, slug, name, status)
       VALUES ($1, $2, $3, 'active')`,
      [orgId, `${runTag}-${slugSuffix}`, `Test Org ${slugSuffix}`],
    );
  }

  async function seedEngagedPatient(
    orgId: string,
    patientId: string,
    email: string,
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
    // One completion of a DAILY task, 5 days ago → overdue today. This makes
    // the patient "engaged" (has a completion) AND nudge-worthy (overdue).
    // `source` must satisfy patient_maintenance_log_source_enum (mig 0088):
    // one of patient_portal | csr_proxy | system.
    await pool.query(
      `INSERT INTO resupply.patient_maintenance_log
         (org_id, patient_id, task_key, completed_at, source)
       VALUES ($1, $2, $3, $4, 'patient_portal')`,
      [
        orgId,
        patientId,
        DAILY_TASK,
        new Date(Date.now() - FIVE_DAYS_MS).toISOString(),
      ],
    );
  }

  beforeAll(async () => {
    // Probe the org-scoped tables this sweep touches; skip cleanly if the
    // DATABASE_URL points at a DB without our migrations applied.
    try {
      await getDbPool().query(
        `SELECT org_id FROM resupply.patient_maintenance_nudges LIMIT 0`,
      );
      await getDbPool().query(`SELECT org_id FROM resupply.patients LIMIT 0`);
      migrationsReady = true;
    } catch {
      migrationsReady = false;
    }
    if (migrationsReady) {
      await seedOrg(orgAId, "a");
      await seedOrg(orgBId, "b");
      await seedEngagedPatient(orgAId, patientAId, emailA);
      await seedEngagedPatient(orgBId, patientBId, emailB);
    }
  });

  beforeEach(() => sendEmailMock.mockClear());

  afterAll(async () => {
    if (migrationsReady) {
      const pool = getDbPool();
      // Children first (FKs), then patients, then the orgs. Scoped to our
      // two run orgs so we never touch another suite's rows.
      const orgIds = [orgAId, orgBId];
      await pool.query(
        `DELETE FROM resupply.patient_maintenance_nudges WHERE org_id = ANY($1)`,
        [orgIds],
      );
      await pool.query(
        `DELETE FROM resupply.patient_maintenance_log WHERE org_id = ANY($1)`,
        [orgIds],
      );
      await pool.query(`DELETE FROM resupply.patients WHERE org_id = ANY($1)`, [
        orgIds,
      ]);
      await pool.query(
        `DELETE FROM resupply.organizations WHERE id = ANY($1)`,
        [orgIds],
      );
    }
    await __resetDbPoolForTests();
  });

  it("nudges both tenants' overdue patients with no cross-tenant leak", async (ctx) => {
    if (!migrationsReady) {
      ctx.skip();
      return;
    }

    const stats = await runMaintenanceNudgeSweep(FULL_CFG);

    // Both seeded patients are overdue → at least our two emails went out
    // (other parallel suites' orgs could contribute more, so assert >=).
    expect(stats.emailed).toBeGreaterThanOrEqual(2);
    expect(stats.errors).toBe(0);

    // Each tenant's patient was emailed exactly via their own roster walk.
    const ourSends = sendEmailMock.mock.calls
      .map((c) => (c[0] as { to?: string } | undefined)?.to)
      .filter(
        (to): to is string =>
          typeof to === "string" && to.startsWith(`${runTag}+`),
      );
    expect(ourSends).toEqual(expect.arrayContaining([emailA, emailB]));

    // Cross-tenant isolation — read each tenant's nudge log back through
    // its OWN org-scoped client. Org A's log must contain patient A and
    // never patient B, and vice-versa. This is the property the fan-out
    // exists to guarantee.
    const aClient = getOrgScopedClient(orgAId);
    const { data: aNudges, error: aErr } = await aClient
      .from("patient_maintenance_nudges")
      .select("patient_id");
    expect(aErr).toBeNull();
    const aPatientIds = (aNudges ?? []).map(
      (r: { patient_id: string }) => r.patient_id,
    );
    expect(aPatientIds).toContain(patientAId);
    expect(aPatientIds).not.toContain(patientBId);

    const bClient = getOrgScopedClient(orgBId);
    const { data: bNudges, error: bErr } = await bClient
      .from("patient_maintenance_nudges")
      .select("patient_id");
    expect(bErr).toBeNull();
    const bPatientIds = (bNudges ?? []).map(
      (r: { patient_id: string }) => r.patient_id,
    );
    expect(bPatientIds).toContain(patientBId);
    expect(bPatientIds).not.toContain(patientAId);
  });
});

// Integration test for the multi-tenant PacWare "ready to sync" digest
// fan-out (G2).
//
// The companion unit test (`pacware-ready-to-sync-digest.test.ts`) verifies,
// against the Supabase mock, that the per-tenant body honours the opt-in and
// that the wrapper fans out + aggregates. That mock can't catch what this
// suite does:
//
//   * that each tenant's `pacware.auto_sync` opt-in AND the confirmed-episode
//     count actually scope to that tenant's `org_id` on a REAL PostgREST
//     surface (the thing the fan-out exists to guarantee), and
//   * that one tenant's confirmed episodes are NEVER counted into another
//     tenant's digest — the cross-tenant leak the fan-out must not introduce.
//
// It seeds TWO active orgs — org A with ONE confirmed episode, org B with
// TWO — both opted into auto-sync, then asserts each tenant's digest reports
// exactly its OWN count (1 and 2, never 3) and that reading episodes back
// through each org-scoped client stays isolated.
//
// Skip-when-unconfigured contract: same env triad as
// maintenance-nudges.integration.test.ts. When any of
// DATABASE_URL / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY is missing the
// whole suite skips so `pnpm -r test` stays green in lanes without a DB.
//
// Cleanup is surgical: every seeded row hangs off two per-run org ids and we
// DELETE only those in afterAll. We never truncate — other suites may be
// running in parallel.

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

// Mock SendGrid BEFORE importing the worker so the digest's
// createSendgridClient resolves to our stub — we don't hit the real API or
// leak fake recipients. Supabase is NOT mocked: the digest must exercise the
// real org-scoped PostgREST path for this suite to be meaningful.
const sendEmailMock = vi.fn(
  async (..._args: unknown[]) => undefined as unknown,
);
vi.mock("@workspace/resupply-email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/resupply-email")>()),
  createSendgridClient: () => ({ sendEmail: sendEmailMock }),
  // The digest only ever throws EmailConfigError on a missing key; our stub
  // never throws, so a class shape is enough for the `instanceof` guard.
  EmailConfigError: class EmailConfigError extends Error {},
}));

import {
  __resetDbPoolForTests,
  getDbPool,
  getOrgScopedClient,
} from "@workspace/resupply-db";

import {
  pacwareDigestForOrg,
  runPacwareReadyToSyncDigest,
} from "./pacware-ready-to-sync-digest";

const skip =
  !process.env.DATABASE_URL ||
  !process.env.SUPABASE_URL ||
  !process.env.SUPABASE_SERVICE_ROLE_KEY;

const describeIfDb = skip ? describe.skip : describe;

const AUTO_SYNC_KEY = "pacware.auto_sync";
const RECIPIENT = "ops@pacware-it.example.test";
const PRACTICE = "Penn Home Medical Supply";

describeIfDb("pacware ready-to-sync digest fan-out (live db)", () => {
  const runTag = `pacware-digest-it-${Math.random().toString(36).slice(2, 10)}`;
  const orgAId = randomUUID();
  const orgBId = randomUUID();

  let migrationsReady = false;

  async function seedOrg(orgId: string, slugSuffix: string): Promise<void> {
    const pool = getDbPool();
    await pool.query(
      `INSERT INTO resupply.organizations (id, slug, name, status)
       VALUES ($1, $2, $3, 'active')`,
      [orgId, `${runTag}-${slugSuffix}`, `Test Org ${slugSuffix}`],
    );
    // Opt this tenant into PacWare auto-sync notices.
    await pool.query(
      `INSERT INTO resupply.app_config (org_id, key, value)
       VALUES ($1, $2, 'true')`,
      [orgId, AUTO_SYNC_KEY],
    );
  }

  /** Seed one confirmed episode (patient + prescription + episode) for an org. */
  async function seedConfirmedEpisode(orgId: string): Promise<void> {
    const pool = getDbPool();
    const patientId = randomUUID();
    const prescriptionId = randomUUID();
    await pool.query(
      `INSERT INTO resupply.patients
         (id, org_id, legal_first_name, legal_last_name, date_of_birth,
          email, timezone, status)
       VALUES ($1, $2, 'Test', 'Patient', '1970-01-01',
               $3, 'America/New_York', 'active')`,
      [patientId, orgId, `${runTag}+${patientId}@example.test`],
    );
    await pool.query(
      `INSERT INTO resupply.prescriptions
         (id, org_id, patient_id, item_sku, cadence_days, valid_from, status)
       VALUES ($1, $2, $3, 'SKU-TEST', 30, '2020-01-01', 'active')`,
      [prescriptionId, orgId, patientId],
    );
    await pool.query(
      `INSERT INTO resupply.episodes
         (org_id, patient_id, prescription_id, status, due_at)
       VALUES ($1, $2, $3, 'confirmed', now())`,
      [orgId, patientId, prescriptionId],
    );
  }

  beforeAll(async () => {
    // Probe the org-scoped tables this digest touches; skip cleanly if the
    // DATABASE_URL points at a DB without our migrations applied.
    try {
      await getDbPool().query(`SELECT org_id FROM resupply.app_config LIMIT 0`);
      await getDbPool().query(`SELECT org_id FROM resupply.episodes LIMIT 0`);
      migrationsReady = true;
    } catch {
      migrationsReady = false;
    }
    if (migrationsReady) {
      await seedOrg(orgAId, "a");
      await seedOrg(orgBId, "b");
      // org A: 1 confirmed episode. org B: 2.
      await seedConfirmedEpisode(orgAId);
      await seedConfirmedEpisode(orgBId);
      await seedConfirmedEpisode(orgBId);
    }
  });

  beforeEach(() => sendEmailMock.mockClear());

  afterAll(async () => {
    if (migrationsReady) {
      const pool = getDbPool();
      const orgIds = [orgAId, orgBId];
      // Children first (FKs), then parents. Scoped to our two run orgs so we
      // never touch another suite's rows.
      await pool.query(`DELETE FROM resupply.episodes WHERE org_id = ANY($1)`, [
        orgIds,
      ]);
      await pool.query(
        `DELETE FROM resupply.prescriptions WHERE org_id = ANY($1)`,
        [orgIds],
      );
      await pool.query(`DELETE FROM resupply.patients WHERE org_id = ANY($1)`, [
        orgIds,
      ]);
      await pool.query(
        `DELETE FROM resupply.app_config WHERE org_id = ANY($1)`,
        [orgIds],
      );
      await pool.query(
        `DELETE FROM resupply.organizations WHERE id = ANY($1)`,
        [orgIds],
      );
    }
    await __resetDbPoolForTests();
  });

  it("reports each tenant's OWN confirmed count, never the other's", async (ctx) => {
    if (!migrationsReady) {
      ctx.skip();
      return;
    }

    // The core property: the count is org-scoped on a real PostgREST surface.
    const a = await pacwareDigestForOrg(orgAId, {
      recipient: RECIPIENT,
      practiceName: PRACTICE,
    });
    expect(a).toEqual({ readyCount: 1, sent: true });

    const b = await pacwareDigestForOrg(orgBId, {
      recipient: RECIPIENT,
      practiceName: PRACTICE,
    });
    expect(b).toEqual({ readyCount: 2, sent: true });

    // Each tenant's digest subject carries only its own count — org A never
    // sees org B's episodes lumped in (would be 3).
    const subjects = sendEmailMock.mock.calls.map(
      (c) => (c[0] as { subject?: string } | undefined)?.subject ?? "",
    );
    expect(subjects.some((s) => s.includes("1 confirmed resupply"))).toBe(true);
    expect(subjects.some((s) => s.includes("2 confirmed resupply"))).toBe(true);
    expect(subjects.some((s) => s.includes("3 confirmed resupply"))).toBe(
      false,
    );

    // Cross-tenant isolation — read each tenant's confirmed episodes back
    // through its OWN org-scoped client. The counts must stay 1 and 2.
    const aClient = getOrgScopedClient(orgAId);
    const { count: aCount, error: aErr } = await aClient
      .from("episodes")
      .select("id", { count: "exact", head: true })
      .eq("status", "confirmed");
    expect(aErr).toBeNull();
    expect(aCount).toBe(1);

    const bClient = getOrgScopedClient(orgBId);
    const { count: bCount, error: bErr } = await bClient
      .from("episodes")
      .select("id", { count: "exact", head: true })
      .eq("status", "confirmed");
    expect(bErr).toBeNull();
    expect(bCount).toBe(2);
  });

  it("fans out across active tenants and sends a digest for each opted-in tenant", async (ctx) => {
    if (!migrationsReady) {
      ctx.skip();
      return;
    }

    process.env.RESUPPLY_ADMIN_ALERTS_EMAIL = RECIPIENT;
    const result = await runPacwareReadyToSyncDigest();

    // Our two seeded orgs both opted in with confirmed orders → at least two
    // sends (other parallel suites' opted-in orgs could add more, so >=).
    expect(result.sentCount).toBeGreaterThanOrEqual(2);
    // Neither of our orgs threw.
    expect(result.failedOrgIds).not.toContain(orgAId);
    expect(result.failedOrgIds).not.toContain(orgBId);
    expect(sendEmailMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

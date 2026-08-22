// Integration test for the multi-tenant recall-notification fan-out (G2).
//
// The fan-out unit test (`recall-notifications-send.fan-out.test.ts`)
// verifies the sweep walks every active tenant against the Supabase mock.
// This suite proves, on a REAL PostgREST surface, what the mock can't:
//
//   * each tenant's queued-notification scan + claim + send runs scoped to
//     that tenant's `org_id`, and
//   * one tenant's queued recall notice is NEVER sent or claimed under
//     another tenant — the cross-tenant leak the fan-out must not introduce.
//
// It seeds TWO active orgs, each with the full recall chain (patient →
// equipment_asset → equipment_recall → a 'queued' recall_notification),
// runs the real sweep, and asserts both notices are emailed AND each
// tenant's notification flips to 'sent' only under its own org.
//
// Skip-when-unconfigured: same env triad as the other worker integration
// tests. SendGrid is mocked (and toggled on via env so the email channel is
// chosen); Twilio stays unconfigured.

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

// Mock SendGrid BEFORE importing the worker so the recall send resolves to
// our stub (no real send). The email channel is preferred when the patient
// has an email AND the SendGrid config is present (set via env below).
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

import { runRecallSendSweep } from "./recall-notifications-send";

const skip =
  !process.env.DATABASE_URL ||
  !process.env.SUPABASE_URL ||
  !process.env.SUPABASE_SERVICE_ROLE_KEY;

const describeIfDb = skip ? describe.skip : describe;

interface Tenant {
  orgId: string;
  patientId: string;
  assetId: string;
  recallId: string;
  notificationId: string;
  email: string;
}

describeIfDb("recall-notifications-send fan-out (live db)", () => {
  const runTag = `recall-it-${Math.random().toString(36).slice(2, 10)}`;
  const a: Tenant = {
    orgId: randomUUID(),
    patientId: randomUUID(),
    assetId: randomUUID(),
    recallId: randomUUID(),
    notificationId: randomUUID(),
    email: `${runTag}+a@example.test`,
  };
  const b: Tenant = {
    orgId: randomUUID(),
    patientId: randomUUID(),
    assetId: randomUUID(),
    recallId: randomUUID(),
    notificationId: randomUUID(),
    email: `${runTag}+b@example.test`,
  };

  let migrationsReady = false;
  const priorEnv: Record<string, string | undefined> = {};

  async function seedTenant(t: Tenant, slugSuffix: string): Promise<void> {
    const pool = getDbPool();
    await pool.query(
      `INSERT INTO resupply.organizations (id, slug, name, status)
       VALUES ($1, $2, $3, 'active')`,
      [t.orgId, `${runTag}-${slugSuffix}`, `Test Org ${slugSuffix}`],
    );
    await pool.query(
      `INSERT INTO resupply.patients
         (id, org_id, legal_first_name, legal_last_name, date_of_birth,
          email, timezone, status)
       VALUES ($1, $2, 'Test', 'Patient', '1970-01-01', $3,
               'America/New_York', 'active')`,
      [t.patientId, t.orgId, t.email],
    );
    await pool.query(
      `INSERT INTO resupply.equipment_assets
         (id, org_id, patient_id, device_class, manufacturer, model,
          serial_number, status)
       VALUES ($1, $2, $3, 'cpap', 'ResMed', 'AirSense 11',
               $4, 'recalled')`,
      [t.assetId, t.orgId, t.patientId, `SN-${slugSuffix}-${runTag}`],
    );
    await pool.query(
      `INSERT INTO resupply.equipment_recalls
         (id, org_id, recall_reference, title, manufacturer, severity, status)
       VALUES ($1, $2, $3, 'Test recall', 'ResMed', 'advisory', 'active')`,
      [t.recallId, t.orgId, `REF-${slugSuffix}-${runTag}`],
    );
    await pool.query(
      `INSERT INTO resupply.recall_notifications
         (id, org_id, recall_id, asset_id, patient_id, status)
       VALUES ($1, $2, $3, $4, $5, 'queued')`,
      [t.notificationId, t.orgId, t.recallId, t.assetId, t.patientId],
    );
  }

  beforeAll(async () => {
    // Toggle the email channel on (the recall send prefers email when the
    // patient has one AND the SendGrid config is present). SendGrid itself
    // is mocked, so these values are never used to authenticate.
    for (const [k, v] of [
      ["SENDGRID_API_KEY", "SG.integration-test"],
      ["SENDGRID_FROM_NAME", "Penn Home Medical Supply"],
      ["SENDGRID_FROM_EMAIL", "info@pennpaps.example"],
    ] as const) {
      priorEnv[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      await getDbPool().query(
        `SELECT org_id FROM resupply.recall_notifications LIMIT 0`,
      );
      migrationsReady = true;
    } catch {
      migrationsReady = false;
    }
    if (migrationsReady) {
      await seedTenant(a, "a");
      await seedTenant(b, "b");
    }
  });

  beforeEach(() => sendEmailMock.mockClear());

  afterAll(async () => {
    if (migrationsReady) {
      const pool = getDbPool();
      const orgIds = [a.orgId, b.orgId];
      // Children first (FK order), then the orgs.
      await pool.query(
        `DELETE FROM resupply.recall_notifications WHERE org_id = ANY($1)`,
        [orgIds],
      );
      await pool.query(
        `DELETE FROM resupply.equipment_recalls WHERE org_id = ANY($1)`,
        [orgIds],
      );
      await pool.query(
        `DELETE FROM resupply.equipment_assets WHERE org_id = ANY($1)`,
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
    for (const [k, v] of Object.entries(priorEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await __resetDbPoolForTests();
  });

  it("sends both tenants' queued recall notices with no cross-tenant leak", async (ctx) => {
    if (!migrationsReady) {
      ctx.skip();
      return;
    }

    const stats = await runRecallSendSweep();

    expect(stats.sent).toBeGreaterThanOrEqual(2);
    expect(stats.failed).toBe(0);

    const ourSends = sendEmailMock.mock.calls
      .map((c) => (c[0] as { to?: string } | undefined)?.to)
      .filter(
        (to): to is string =>
          typeof to === "string" && to.startsWith(`${runTag}+`),
      );
    expect(ourSends).toEqual(expect.arrayContaining([a.email, b.email]));

    // Cross-tenant isolation — read each tenant's notifications back through
    // its OWN org-scoped client. Org A's notice flipped to 'sent'; org A's
    // client must never see org B's notice.
    const aClient = getOrgScopedClient(a.orgId);
    const { data: aRows, error: aErr } = await aClient
      .from("recall_notifications")
      .select("id, status");
    expect(aErr).toBeNull();
    const aById = new Map(
      (aRows ?? []).map((r: { id: string; status: string }) => [
        r.id,
        r.status,
      ]),
    );
    expect(aById.get(a.notificationId)).toBe("sent");
    expect(aById.has(b.notificationId)).toBe(false);

    const bClient = getOrgScopedClient(b.orgId);
    const { data: bRows, error: bErr } = await bClient
      .from("recall_notifications")
      .select("id, status");
    expect(bErr).toBeNull();
    const bById = new Map(
      (bRows ?? []).map((r: { id: string; status: string }) => [
        r.id,
        r.status,
      ]),
    );
    expect(bById.get(b.notificationId)).toBe("sent");
    expect(bById.has(a.notificationId)).toBe(false);
  });
});

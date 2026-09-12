// Integration test for the multi-tenant patient-packet reminder fan-out (G2).
//
// The fan-out unit test (`patient-packet-reminders.test.ts`) verifies the
// per-tenant flag gate against mocks. This suite proves, on a REAL
// PostgREST surface, what the mock can't:
//
//   * each tenant's packet scan + compare-and-set claim runs scoped to that
//     tenant's `org_id`, and
//   * one tenant's unsigned packet is NEVER claimed/reminded under another
//     tenant — the cross-tenant leak the fan-out must not introduce.
//
// It seeds TWO active orgs (autoremind flag ON), each with one
// reminder-eligible packet, runs the real sweep, and asserts both packets
// are claimed (reminder_count bumped) only under their own org. The link
// signing + delivery are stubbed (they need auth-deps / vendor creds); the
// claim itself — the org-scoped write under test — hits the real DB.

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

// Stub link-signing + delivery (auth-deps / vendor creds), keep the rest.
const deliverMock = vi.hoisted(() =>
  vi.fn(async (_options: { packetId: string }) => ({
    emailSent: true,
    smsSent: false,
  })),
);
const linkMock = vi.hoisted(() =>
  vi.fn(
    async (): Promise<string | null> => "https://test.example/sign?token=stub",
  ),
);
vi.mock("../../lib/patient-packet/send", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/patient-packet/send")
  >("../../lib/patient-packet/send");
  return {
    ...actual,
    buildPacketSigningLink: linkMock,
    deliverPacketLink: deliverMock,
  };
});

import {
  __resetDbPoolForTests,
  getDbPool,
  getOrgScopedClient,
} from "@workspace/resupply-db";

import { runPatientPacketReminderSweep } from "./patient-packet-reminders";

const skip =
  !process.env.DATABASE_URL ||
  !process.env.SUPABASE_URL ||
  !process.env.SUPABASE_SERVICE_ROLE_KEY;

const describeIfDb = skip ? describe.skip : describe;

interface Tenant {
  orgId: string;
  patientId: string;
  packetId: string;
}

describeIfDb("patient-packet-reminders fan-out (live db)", () => {
  const runTag = `packet-it-${Math.random().toString(36).slice(2, 10)}`;
  const a: Tenant = {
    orgId: randomUUID(),
    patientId: randomUUID(),
    packetId: randomUUID(),
  };
  const b: Tenant = {
    orgId: randomUUID(),
    patientId: randomUUID(),
    packetId: randomUUID(),
  };

  let migrationsReady = false;

  async function seedTenant(t: Tenant, slugSuffix: string): Promise<void> {
    const pool = getDbPool();
    await pool.query(
      `INSERT INTO resupply.organizations (id, slug, name, status)
       VALUES ($1, $2, $3, 'active')`,
      [t.orgId, `${runTag}-${slugSuffix}`, `Test Org ${slugSuffix}`],
    );
    await pool.query(
      `INSERT INTO resupply.feature_flags
         (org_id, key, enabled, description, category)
       VALUES ($1, 'patient_packets.autoremind', true, 'integration test', 'test')`,
      [t.orgId],
    );
    await pool.query(
      `INSERT INTO resupply.patients
         (id, org_id, legal_first_name, legal_last_name, date_of_birth,
          email, timezone, status)
       VALUES ($1, $2, 'Test', 'Patient', '1970-01-01',
               $3, 'America/New_York', 'active')`,
      [t.patientId, t.orgId, `${runTag}+${slugSuffix}@example.test`],
    );
    // A 'sent' packet, sent 4 days ago (past REMIND_AFTER_DAYS=3), never
    // reminded, not yet expired → reminder-eligible.
    const now = Date.now();
    await pool.query(
      `INSERT INTO resupply.patient_packets
         (id, org_id, patient_id, title, status, recipient_name,
          recipient_email, link_version, reminder_count, sent_at,
          expires_at, last_reminded_at)
       VALUES ($1, $2, $3, 'Test Packet', 'sent', 'Test Patient',
               $4, 1, 0, $5, $6, NULL)`,
      [
        t.packetId,
        t.orgId,
        t.patientId,
        `${runTag}+${slugSuffix}@example.test`,
        new Date(now - 4 * 86_400_000).toISOString(),
        new Date(now + 7 * 86_400_000).toISOString(),
      ],
    );
  }

  beforeAll(async () => {
    try {
      await getDbPool().query(
        `SELECT org_id FROM resupply.patient_packets LIMIT 0`,
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

  beforeEach(async () => {
    deliverMock
      .mockReset()
      .mockResolvedValue({ emailSent: true, smsSent: false });
    linkMock
      .mockReset()
      .mockResolvedValue("https://test.example/sign?token=stub");
    if (migrationsReady)
      await getDbPool().query(
        `UPDATE resupply.patient_packets SET status = 'sent', link_version = 1,
         reminder_count = 0, last_reminded_at = NULL, completed_at = NULL,
         sent_at = now() - interval '4 days', expires_at = now() + interval '7 days'
       WHERE id = ANY($1)`,
        [[a.packetId, b.packetId]],
      );
  });

  afterAll(async () => {
    if (migrationsReady) {
      const pool = getDbPool();
      const orgIds = [a.orgId, b.orgId];
      await pool.query(
        `DELETE FROM resupply.patient_packets WHERE org_id = ANY($1)`,
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
    await __resetDbPoolForTests();
  });

  it("reminds both tenants' eligible packets with no cross-tenant leak", async (ctx) => {
    if (!migrationsReady) {
      ctx.skip();
      return;
    }

    const stats = await runPatientPacketReminderSweep();

    expect(stats.skipped).toBeFalsy();
    expect(stats.reminded).toBeGreaterThanOrEqual(2);

    // Cross-tenant isolation — read each tenant's packets back through its
    // OWN org-scoped client. Org A's packet was claimed (reminder_count
    // bumped to 1); org A's client must never see org B's packet.
    const aClient = getOrgScopedClient(a.orgId);
    const { data: aRows, error: aErr } = await aClient
      .from("patient_packets")
      .select("id, reminder_count");
    expect(aErr).toBeNull();
    const aById = new Map(
      (aRows ?? []).map((r: { id: string; reminder_count: number }) => [
        r.id,
        r.reminder_count,
      ]),
    );
    expect(aById.get(a.packetId)).toBe(1);
    expect(aById.has(b.packetId)).toBe(false);

    const bClient = getOrgScopedClient(b.orgId);
    const { data: bRows, error: bErr } = await bClient
      .from("patient_packets")
      .select("id, reminder_count");
    expect(bErr).toBeNull();
    const bById = new Map(
      (bRows ?? []).map((r: { id: string; reminder_count: number }) => [
        r.id,
        r.reminder_count,
      ]),
    );
    expect(bById.get(b.packetId)).toBe(1);
    expect(bById.has(a.packetId)).toBe(false);
  });

  it.for(["completed", "voided"])(
    "does not reopen a packet %s after the scan",
    async (status, ctx) => {
      if (!migrationsReady) return ctx.skip();
      const client = await getDbPool().connect();
      let sweep: ReturnType<typeof runPatientPacketReminderSweep> | undefined;
      try {
        await client.query("BEGIN");
        const { rows } = await client.query("SELECT pg_backend_pid() AS pid");
        await client.query(
          "SELECT id FROM resupply.patient_packets WHERE id = $1 FOR UPDATE",
          [a.packetId],
        );
        sweep = runPatientPacketReminderSweep();
        // Wait until the real PostgREST claim is blocked on this row, then
        // finish signing/voiding before it can acquire the packet lock.
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const result = await getDbPool().query(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked",
            [rows[0].pid],
          );
          if (result.rows[0].blocked) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(blocked).toBe(true);
        await client.query(
          "UPDATE resupply.patient_packets SET status = $2 WHERE id = $1",
          [a.packetId, status],
        );
        await client.query("COMMIT");
        await sweep;
        const result = await client.query(
          "SELECT status, link_version, reminder_count FROM resupply.patient_packets WHERE id = $1",
          [a.packetId],
        );
        expect(result.rows[0]).toEqual({
          status,
          link_version: 1,
          reminder_count: 0,
        });
        expect(
          deliverMock.mock.calls.some(
            ([options]) => options.packetId === a.packetId,
          ),
        ).toBe(false);
      } finally {
        await client.query("ROLLBACK");
        client.release();
        await sweep;
      }
    },
  );

  it("does not roll a completed packet back after unsuccessful delivery", async (ctx) => {
    if (!migrationsReady) return ctx.skip();
    deliverMock.mockImplementation(async ({ packetId }) => {
      await getDbPool().query(
        "UPDATE resupply.patient_packets SET status = 'completed', completed_at = now() WHERE id = $1",
        [packetId],
      );
      return { emailSent: false, smsSent: false };
    });
    await runPatientPacketReminderSweep();
    const { rows } = await getDbPool().query(
      "SELECT status, link_version FROM resupply.patient_packets WHERE id = $1",
      [a.packetId],
    );
    expect(rows[0]).toEqual({ status: "completed", link_version: 2 });
  });

  it("keeps the previous link and reminder allowance when no domain is available", async (ctx) => {
    if (!migrationsReady) return ctx.skip();
    linkMock.mockResolvedValue(null);
    await runPatientPacketReminderSweep();
    const { rows } = await getDbPool().query(
      "SELECT link_version, reminder_count FROM resupply.patient_packets WHERE id = $1",
      [a.packetId],
    );
    expect(rows[0]).toEqual({ link_version: 1, reminder_count: 0 });
    expect(deliverMock).not.toHaveBeenCalled();
  });
});

// Integration test for the multi-tenant reminder-scan fan-out (G2).
//
// The reminder scan is the dominant patient-comms path. Before the fan-out
// it resolved a single seed org, so a second tenant's due reminders were
// never found. `scanForDueReminders(orgId, asOf)` now takes the tenant
// explicitly and reads every candidate table on that tenant's org-scoped
// client; the scan worker fans it out across active tenants and stamps each
// enqueued send with its `orgId`.
//
// This suite pins the property the fan-out exists to guarantee, on a REAL
// PostgREST surface (the Supabase mock can't): each tenant's scan returns
// ONLY its own due patient, never the other tenant's. It seeds two active
// orgs, each with one active+overdue prescription (no fulfillment → due) and
// an episode, then runs the scan once per org with a fixed in-business-hours
// `asOf` (so the quiet-hours deferral is deterministic).
//
// Skip-when-unconfigured contract: same env triad as
// maintenance-nudges.integration.test.ts. When any of
// DATABASE_URL / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY is missing the
// whole suite skips so `pnpm -r test` stays green in lanes without a DB.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { __resetDbPoolForTests, getDbPool } from "@workspace/resupply-db";

import { scanForDueReminders } from "./reminders";

const skip =
  !process.env.DATABASE_URL ||
  !process.env.SUPABASE_URL ||
  !process.env.SUPABASE_SERVICE_ROLE_KEY;

const describeIfDb = skip ? describe.skip : describe;

// 1pm US-Eastern (EDT) — inside the 9am–8pm local send window, so the
// quiet-hours deferral never fires and the seeded patient is enqueue-eligible.
const AS_OF = new Date("2026-06-15T17:00:00Z");
const SIXTY_DAYS_AGO = new Date(
  AS_OF.getTime() - 60 * 86_400_000,
).toISOString();

describeIfDb("reminder scan fan-out (live db)", () => {
  const runTag = `reminders-it-${Math.random().toString(36).slice(2, 10)}`;
  const orgAId = randomUUID();
  const orgBId = randomUUID();
  const patientAId = randomUUID();
  const patientBId = randomUUID();

  let migrationsReady = false;

  async function seedOrg(orgId: string, slugSuffix: string): Promise<void> {
    const pool = getDbPool();
    await pool.query(
      `INSERT INTO resupply.organizations (id, slug, name, status)
       VALUES ($1, $2, $3, 'active')`,
      [orgId, `${runTag}-${slugSuffix}`, `Test Org ${slugSuffix}`],
    );
  }

  // One active patient (email, no phone → email channel) with one active
  // prescription created 60 days ago and NO fulfillment, so the cadence
  // baseline (prescription.created_at) is well past a 1-day cadence → due.
  async function seedDuePatient(
    orgId: string,
    patientId: string,
  ): Promise<void> {
    const pool = getDbPool();
    const prescriptionId = randomUUID();
    await pool.query(
      `INSERT INTO resupply.patients
         (id, org_id, legal_first_name, legal_last_name, date_of_birth,
          email, phone_e164, timezone, status)
       VALUES ($1, $2, 'Test', 'Patient', '1970-01-01',
               $3, NULL, 'America/New_York', 'active')`,
      [patientId, orgId, `${runTag}+${patientId}@example.test`],
    );
    await pool.query(
      `INSERT INTO resupply.prescriptions
         (id, org_id, patient_id, item_sku, cadence_days, valid_from,
          status, created_at)
       VALUES ($1, $2, $3, 'SKU-TEST', 1, '2020-01-01', 'active', $4)`,
      [prescriptionId, orgId, patientId, SIXTY_DAYS_AGO],
    );
    await pool.query(
      `INSERT INTO resupply.episodes
         (org_id, patient_id, prescription_id, status, due_at)
       VALUES ($1, $2, $3, 'outreach_pending', $4)`,
      [orgId, patientId, prescriptionId, AS_OF.toISOString()],
    );
  }

  beforeAll(async () => {
    try {
      // Probe EVERY table the scan reads so a partially-migrated DB skips
      // cleanly instead of seeding then failing mid-scan on PostgREST.
      for (const table of [
        "frequency_rules",
        "prescriptions",
        "episodes",
        "patients",
        "fulfillments",
        "conversations",
      ]) {
        await getDbPool().query(`SELECT org_id FROM resupply.${table} LIMIT 0`);
      }
      migrationsReady = true;
    } catch {
      migrationsReady = false;
    }
    if (migrationsReady) {
      await seedOrg(orgAId, "a");
      await seedOrg(orgBId, "b");
      await seedDuePatient(orgAId, patientAId);
      await seedDuePatient(orgBId, patientBId);
    }
  });

  afterAll(async () => {
    if (migrationsReady) {
      const pool = getDbPool();
      const orgIds = [orgAId, orgBId];
      // Children first (FKs), then patients, then the orgs. Scoped to our two
      // run orgs so we never touch another suite's rows.
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
        `DELETE FROM resupply.organizations WHERE id = ANY($1)`,
        [orgIds],
      );
    }
    await __resetDbPoolForTests();
  });

  it("scopes each tenant's due-reminder scan to its own org — no cross-tenant leak", async (ctx) => {
    if (!migrationsReady) {
      ctx.skip();
      return;
    }

    // Org A's scan sees org A's due patient and NOT org B's.
    const rowsA = await scanForDueReminders(orgAId, AS_OF);
    const aPatientIds = rowsA.map((r) => r.patientId);
    expect(aPatientIds).toContain(patientAId);
    expect(aPatientIds).not.toContain(patientBId);

    // Org B's scan sees org B's due patient and NOT org A's.
    const rowsB = await scanForDueReminders(orgBId, AS_OF);
    const bPatientIds = rowsB.map((r) => r.patientId);
    expect(bPatientIds).toContain(patientBId);
    expect(bPatientIds).not.toContain(patientAId);

    // No phone → the resolved channel is email for our seeded patient.
    const aRow = rowsA.find((r) => r.patientId === patientAId);
    expect(aRow?.channel).toBe("email");
  });

  it("returns nothing for an org with no due patients", async (ctx) => {
    if (!migrationsReady) {
      ctx.skip();
      return;
    }
    // A fresh, unseeded org id resolves no active prescriptions → empty scan.
    const rows = await scanForDueReminders(randomUUID(), AS_OF);
    expect(rows).toEqual([]);
  });
});

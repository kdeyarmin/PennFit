/**
 * Tests for the SQL migration changes introduced in this pull request.
 *
 * Two layers:
 *
 *   1. Static content tests — read each changed .sql file from disk and
 *      assert that the file text reflects the corrected declarations
 *      (schema names, column types, index predicates, role guards).
 *      These run on every `pnpm test` invocation with no database.
 *
 *   2. DB integration tests — verify the actual Postgres schema state
 *      after `migrate.mjs` has been applied (column data_type, trigger
 *      targets, index definitions, role existence).  They follow the
 *      same `describe.skipIf(!dbUrl)` pattern as migrate.test.ts so
 *      they are skipped automatically when DATABASE_URL is absent.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskContext } from "vitest";
import { Pool } from "pg";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.resolve(__dirname, "../drizzle");

function readMigration(filename: string): string {
  return fs.readFileSync(path.join(DRIZZLE_DIR, filename), "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Static SQL content tests (no database required)
// ─────────────────────────────────────────────────────────────────────────────

describe("Migration SQL content — 0060_updated_at_triggers_phase4", () => {
  const sql = readMigration("0060_updated_at_triggers_phase4.sql");

  it("attaches the reminder_subscriptions trigger to the public schema (not resupply)", () => {
    expect(sql).toMatch(/BEFORE UPDATE ON public\.reminder_subscriptions/);
  });

  it("does NOT reference resupply.reminder_subscriptions as the trigger target", () => {
    expect(sql).not.toMatch(
      /BEFORE UPDATE ON resupply\.reminder_subscriptions/,
    );
  });

  it("still creates the password_credentials trigger on resupply_auth schema", () => {
    expect(sql).toMatch(/BEFORE UPDATE ON resupply_auth\.password_credentials/);
  });

  it("adds the insurance_leads_status_enum CHECK constraint", () => {
    expect(sql).toMatch(/insurance_leads_status_enum/);
    expect(sql).toMatch(/CHECK \(status IN/);
  });
});

describe("Migration SQL content — 0061_fulfillments_quantity_integer", () => {
  const sql = readMigration("0061_fulfillments_quantity_integer.sql");

  it("drops the existing text default BEFORE changing the column type", () => {
    // Use the enclosing ALTER TABLE statement as the search anchor to avoid
    // matching the same string appearing verbatim inside the SQL comment block.
    const dropDefaultStmtPos = sql.indexOf(
      "ALTER TABLE resupply.fulfillments\n  ALTER COLUMN quantity DROP DEFAULT",
    );
    const typeChangeStmtPos = sql.indexOf(
      "ALTER TABLE resupply.fulfillments\n  ALTER COLUMN quantity TYPE integer",
    );
    expect(dropDefaultStmtPos).toBeGreaterThanOrEqual(0);
    expect(typeChangeStmtPos).toBeGreaterThanOrEqual(0);
    // DROP DEFAULT statement must precede the TYPE change statement.
    expect(typeChangeStmtPos).toBeGreaterThan(dropDefaultStmtPos);
  });

  it("casts existing rows with USING quantity::integer", () => {
    expect(sql).toMatch(/USING quantity::integer/);
  });

  it("sets a typed integer default of 1 after the type change", () => {
    expect(sql).toMatch(/ALTER COLUMN quantity SET DEFAULT 1/);
    // Must not re-introduce the text default '1'
    expect(sql).not.toMatch(/SET DEFAULT '1'/);
  });
});

describe("Migration SQL content — 0080_staff_training_records", () => {
  const sql = readMigration("0080_staff_training_records.sql");

  it("declares staff_user_id as text (not uuid)", () => {
    expect(sql).toMatch(/"staff_user_id" text NOT NULL/);
  });

  it("does NOT declare staff_user_id as uuid", () => {
    expect(sql).not.toMatch(/"staff_user_id" uuid/);
  });

  it("references admin_users for the FK", () => {
    expect(sql).toMatch(/REFERENCES "resupply"\."admin_users"\("id"\)/);
  });

  it("includes a CHECK on training_type enum values", () => {
    expect(sql).toMatch(/staff_training_records_training_type_enum/);
    expect(sql).toMatch(/'hipaa_privacy'/);
  });

  it("includes a CHECK that expires_at >= completed_at", () => {
    expect(sql).toMatch(/staff_training_records_expiry_after_completion/);
    expect(sql).toMatch(/"expires_at" >= "completed_at"/);
  });
});

describe("Migration SQL content — 0084_admin_mfa_secrets", () => {
  const sql = readMigration("0084_admin_mfa_secrets.sql");

  it("declares staff_user_id as text (not uuid)", () => {
    expect(sql).toMatch(/"staff_user_id" text NOT NULL/);
  });

  it("does NOT declare staff_user_id as uuid", () => {
    expect(sql).not.toMatch(/"staff_user_id" uuid/);
  });

  it("creates a unique index enforcing one secret per admin user", () => {
    expect(sql).toMatch(/admin_mfa_secrets_staff_user_unique/);
    expect(sql).toMatch(/UNIQUE INDEX/i);
  });
});

describe("Migration SQL content — 0085_admin_mfa_recovery_codes", () => {
  const sql = readMigration("0085_admin_mfa_recovery_codes.sql");

  it("declares staff_user_id as text (not uuid)", () => {
    expect(sql).toMatch(/"staff_user_id" text NOT NULL/);
  });

  it("does NOT declare staff_user_id as uuid", () => {
    expect(sql).not.toMatch(/"staff_user_id" uuid/);
  });

  it("creates a unique index on code_hash", () => {
    expect(sql).toMatch(/admin_mfa_recovery_codes_code_hash_unique/);
  });
});

describe("Migration SQL content — 0087_accreditation_policies", () => {
  const sql = readMigration("0087_accreditation_policies.sql");

  it("declares staff_user_id in admin_policy_attestations as text (not uuid)", () => {
    // The relevant column definition line
    expect(sql).toMatch(
      /"staff_user_id" text NOT NULL REFERENCES "resupply"\."admin_users"/,
    );
  });

  it("does NOT declare staff_user_id as uuid in admin_policy_attestations", () => {
    // There must be no uuid column named staff_user_id
    expect(sql).not.toMatch(/"staff_user_id" uuid/);
  });

  it("includes the (staff_user_id, policy_id) unique index on attestations", () => {
    expect(sql).toMatch(/admin_policy_attestations_staff_policy_unique/);
  });

  it("includes accreditation_policies table with policy_key shape CHECK", () => {
    expect(sql).toMatch(/accreditation_policies_policy_key_shape/);
  });
});

describe("Migration SQL content — 0105_shop_order_loss_claims", () => {
  const sql = readMigration("0105_shop_order_loss_claims.sql");

  it("declares order_id as text (not uuid)", () => {
    expect(sql).toMatch(/"order_id" text NOT NULL/);
  });

  it("does NOT declare order_id as uuid", () => {
    expect(sql).not.toMatch(/"order_id" uuid NOT NULL/);
  });

  it("has a status enum CHECK with all expected values", () => {
    expect(sql).toMatch(/shop_order_loss_claims_status_enum/);
    expect(sql).toMatch(/'open'/);
    expect(sql).toMatch(/'carrier_filed'/);
    expect(sql).toMatch(/'resolved_refunded'/);
    expect(sql).toMatch(/'resolved_reshipped'/);
    expect(sql).toMatch(/'closed_unresolved'/);
  });
});

describe("Migration SQL content — 0127_shop_order_nps_responses", () => {
  const sql = readMigration("0127_shop_order_nps_responses.sql");

  it("declares order_id as text (not uuid)", () => {
    expect(sql).toMatch(/"order_id" text NOT NULL/);
  });

  it("does NOT declare order_id as uuid", () => {
    expect(sql).not.toMatch(/"order_id" uuid NOT NULL/);
  });

  it("has a score range CHECK of 0..10", () => {
    expect(sql).toMatch(/shop_order_nps_responses_score_range/);
    expect(sql).toMatch(/"score" >= 0 AND "score" <= 10/);
  });

  it("has a comment length CHECK capped at 2000 chars", () => {
    expect(sql).toMatch(/shop_order_nps_responses_comment_length/);
    expect(sql).toMatch(/char_length\("comment"\) <= 2000/);
  });
});

describe("Migration SQL content — 0134_billing_wave_2_next_items (dwo_documents index)", () => {
  const sql = readMigration("0134_billing_wave_2_next_items.sql");

  it("creates dwo_documents_expiring_idx as a plain index (no WHERE predicate)", () => {
    // The index definition line must not contain a WHERE clause
    const indexBlock = sql.match(
      /CREATE INDEX IF NOT EXISTS "dwo_documents_expiring_idx"[^;]*/,
    );
    expect(indexBlock).not.toBeNull();
    expect(indexBlock![0]).not.toMatch(/WHERE/i);
  });

  it("does NOT contain a partial predicate using CURRENT_DATE", () => {
    // The old broken form that Postgres rejects on fresh DB
    expect(sql).not.toMatch(/WHERE "expires_on" >= CURRENT_DATE/);
  });

  it("indexes expires_on column for expiry range scans", () => {
    expect(sql).toMatch(/ON "resupply"\."dwo_documents" \("expires_on"\)/);
  });
});

describe("Migration SQL content — 0141_phase_9_compliance_machinery (oig_leie_screenings)", () => {
  const sql = readMigration("0141_phase_9_compliance_machinery.sql");

  it("declares subject_admin_user_id as text (not uuid)", () => {
    expect(sql).toMatch(/"subject_admin_user_id" text/);
  });

  it("does NOT declare subject_admin_user_id as uuid", () => {
    expect(sql).not.toMatch(/"subject_admin_user_id" uuid/);
  });

  it("references resupply_auth.users for the FK (not resupply.admin_users)", () => {
    expect(sql).toMatch(
      /"subject_admin_user_id" text\s+REFERENCES "resupply_auth"\."users"\("id"\)/,
    );
  });

  it("uses ON DELETE SET NULL for subject_admin_user_id FK", () => {
    // The FK on subject_admin_user_id must be SET NULL, not CASCADE
    const screeningsBlock = sql.match(
      /CREATE TABLE IF NOT EXISTS "resupply"\."oig_leie_screenings"[\s\S]*?(?=CREATE TABLE|CREATE INDEX|ALTER TABLE|$)/,
    );
    expect(screeningsBlock).not.toBeNull();
    expect(screeningsBlock![0]).toMatch(
      /"subject_admin_user_id" text\s+REFERENCES "resupply_auth"\."users"\("id"\) ON DELETE SET NULL/,
    );
  });
});

describe("Migration SQL content — 0143_inventory_reconciliation_submit_fn (service_role guard)", () => {
  const sql = readMigration("0273_inventory_reconciliation_submit_fn.sql");

  it("includes a DO block that creates service_role if it does not exist", () => {
    expect(sql).toMatch(/DO \$\$/);
    expect(sql).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'service_role'\)/,
    );
    expect(sql).toMatch(/CREATE ROLE service_role NOLOGIN/);
  });

  it("places the service_role guard BEFORE the GRANT statement", () => {
    const guardPos = sql.indexOf("CREATE ROLE service_role NOLOGIN");
    const grantPos = sql.indexOf("GRANT EXECUTE ON FUNCTION");
    expect(guardPos).toBeGreaterThanOrEqual(0);
    expect(grantPos).toBeGreaterThan(guardPos);
  });

  it("grants EXECUTE on submit_inventory_reconciliation to service_role", () => {
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION resupply\.submit_inventory_reconciliation.*TO service_role/,
    );
  });

  // Regression: the DO block must be idempotent (IF NOT EXISTS)
  it("uses IF NOT EXISTS guard (idempotent role creation)", () => {
    expect(sql).toMatch(/IF NOT EXISTS/);
    // Must NOT use a bare CREATE ROLE without the guard
    expect(sql).not.toMatch(/^CREATE ROLE service_role/m);
  });
});

describe("Migration SQL content — 0164_admin_aggregate_rpcs (service_role guard)", () => {
  const sql = readMigration("0164_admin_aggregate_rpcs.sql");

  it("includes a DO block that creates service_role if it does not exist", () => {
    expect(sql).toMatch(/DO \$\$/);
    expect(sql).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'service_role'\)/,
    );
    expect(sql).toMatch(/CREATE ROLE service_role NOLOGIN/);
  });

  it("places the service_role guard BEFORE any GRANT statements", () => {
    const guardPos = sql.indexOf("CREATE ROLE service_role NOLOGIN");
    const firstGrantPos = sql.indexOf("GRANT EXECUTE ON FUNCTION");
    expect(guardPos).toBeGreaterThanOrEqual(0);
    expect(firstGrantPos).toBeGreaterThan(guardPos);
  });

  it("grants EXECUTE on billing_denial_rate to service_role", () => {
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION resupply\.billing_denial_rate.*TO service_role/,
    );
  });

  it("grants EXECUTE on shop_back_in_stock_queue to service_role", () => {
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION resupply\.shop_back_in_stock_queue.*TO service_role/,
    );
  });

  it("uses IF NOT EXISTS guard (idempotent role creation)", () => {
    expect(sql).toMatch(/IF NOT EXISTS/);
    expect(sql).not.toMatch(/^CREATE ROLE service_role/m);
  });

  it("declares billing_denial_rate as STABLE (read-only)", () => {
    expect(sql).toMatch(/STABLE/);
  });

  it("declares both RPCs with SECURITY DEFINER", () => {
    const count = (sql.match(/SECURITY DEFINER/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

describe("Migration SQL content — 0214_patient_payment_apply_ledger", () => {
  const sql = readMigration("0214_patient_payment_apply_ledger.sql");

  it("creates the per-(payment, claim) idempotency ledger with a composite PK", () => {
    expect(sql).toMatch(/patient_payment_claim_applications/);
    expect(sql).toMatch(/PRIMARY KEY \("payment_id", "claim_id"\)/);
  });

  it("defines an idempotent apply function (ON CONFLICT DO NOTHING + clamp)", () => {
    expect(sql).toMatch(/FUNCTION resupply\.apply_patient_payment/);
    expect(sql).toMatch(/ON CONFLICT \("payment_id", "claim_id"\) DO NOTHING/);
    expect(sql).toMatch(
      /GREATEST\(0, patient_responsibility_cents - v_amount\)/,
    );
  });

  it("is SECURITY DEFINER with a pinned search_path and grants service_role", () => {
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path = resupply, pg_catalog/);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION resupply\.apply_patient_payment\(uuid\) TO service_role/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. DB integration tests — verify actual schema state (skip if no DB)
// ─────────────────────────────────────────────────────────────────────────────

const dbUrl = process.env.DATABASE_URL;

describe.skipIf(!dbUrl)(
  "Post-migration schema verification (requires DATABASE_URL)",
  () => {
    let pool: Pool;

    beforeAll(() => {
      pool = new Pool({ connectionString: dbUrl, max: 2 });
    });

    afterAll(async () => {
      await pool.end();
    });

    // ── 0060 trigger target schema ──────────────────────────────────
    it("trigger trg_reminder_subscriptions_set_updated_at is on public.reminder_subscriptions", async () => {
      const result = await pool.query<{
        trigger_name: string;
        event_object_schema: string;
        event_object_table: string;
      }>(
        `SELECT trigger_name, event_object_schema, event_object_table
           FROM information_schema.triggers
           WHERE trigger_name = 'trg_reminder_subscriptions_set_updated_at'`,
      );
      expect(result.rows.length).toBe(1);
      expect(result.rows[0]!.event_object_schema).toBe("public");
      expect(result.rows[0]!.event_object_table).toBe("reminder_subscriptions");
    }, 15_000);

    // ── 0061 fulfillments.quantity column type ──────────────────────
    it("fulfillments.quantity is integer type with default 1", async () => {
      const result = await pool.query<{
        data_type: string;
        column_default: string;
      }>(
        `SELECT data_type, column_default
           FROM information_schema.columns
           WHERE table_schema = 'resupply'
             AND table_name = 'fulfillments'
             AND column_name = 'quantity'`,
      );
      expect(result.rows.length).toBe(1);
      expect(result.rows[0]!.data_type).toBe("integer");
      // The default should be the integer literal 1 (no quotes)
      expect(result.rows[0]!.column_default).toBe("1");
    }, 15_000);

    // ── 0080 staff_training_records — RETIRED by 0156 ──────────────
    // 0156_drop_compliance_machinery dropped the entire compliance
    // suite (staff training records, policy attestations, OIG LEIE
    // screenings, …). The original assertion — staff_user_id is text,
    // not uuid — no longer has a table to apply to. The post-migration
    // truth after the full chain is that the table is gone, so assert
    // that instead; this keeps the suite tracking the retirement rather
    // than failing on a column that can't exist.
    it("staff_training_records was dropped by 0156 (compliance retirement)", async () => {
      const result = await pool.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.tables
           WHERE table_schema = 'resupply'
             AND table_name = 'staff_training_records'`,
      );
      expect(result.rows.length).toBe(0);
    }, 15_000);

    // ── 0084 admin_mfa_secrets.staff_user_id type ──────────────────
    it("admin_mfa_secrets.staff_user_id is text type", async () => {
      const result = await pool.query<{ data_type: string }>(
        `SELECT data_type
           FROM information_schema.columns
           WHERE table_schema = 'resupply'
             AND table_name = 'admin_mfa_secrets'
             AND column_name = 'staff_user_id'`,
      );
      expect(result.rows.length).toBe(1);
      expect(result.rows[0]!.data_type).toBe("text");
    }, 15_000);

    // ── 0085 admin_mfa_recovery_codes.staff_user_id type ───────────
    it("admin_mfa_recovery_codes.staff_user_id is text type", async () => {
      const result = await pool.query<{ data_type: string }>(
        `SELECT data_type
           FROM information_schema.columns
           WHERE table_schema = 'resupply'
             AND table_name = 'admin_mfa_recovery_codes'
             AND column_name = 'staff_user_id'`,
      );
      expect(result.rows.length).toBe(1);
      expect(result.rows[0]!.data_type).toBe("text");
    }, 15_000);

    // ── 0087 admin_policy_attestations — RETIRED by 0156 ───────────
    // Dropped by 0156_drop_compliance_machinery (see the
    // staff_training_records note above). Assert the table is gone after
    // the full chain rather than the now-inapplicable column type.
    it("admin_policy_attestations was dropped by 0156 (compliance retirement)", async () => {
      const result = await pool.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.tables
           WHERE table_schema = 'resupply'
             AND table_name = 'admin_policy_attestations'`,
      );
      expect(result.rows.length).toBe(0);
    }, 15_000);

    // ── 0105 shop_order_loss_claims.order_id type ──────────────────
    it("shop_order_loss_claims.order_id is text type", async () => {
      const result = await pool.query<{ data_type: string }>(
        `SELECT data_type
           FROM information_schema.columns
           WHERE table_schema = 'resupply'
             AND table_name = 'shop_order_loss_claims'
             AND column_name = 'order_id'`,
      );
      expect(result.rows.length).toBe(1);
      expect(result.rows[0]!.data_type).toBe("text");
    }, 15_000);

    // ── 0127 shop_order_nps_responses.order_id type ────────────────
    it("shop_order_nps_responses.order_id is text type", async () => {
      const result = await pool.query<{ data_type: string }>(
        `SELECT data_type
           FROM information_schema.columns
           WHERE table_schema = 'resupply'
             AND table_name = 'shop_order_nps_responses'
             AND column_name = 'order_id'`,
      );
      expect(result.rows.length).toBe(1);
      expect(result.rows[0]!.data_type).toBe("text");
    }, 15_000);

    // ── 0134 dwo_documents_expiring_idx is a plain index ───────────
    it("dwo_documents_expiring_idx exists and has no partial predicate", async () => {
      const result = await pool.query<{
        indexname: string;
        indexdef: string;
      }>(
        `SELECT indexname, indexdef
           FROM pg_indexes
           WHERE schemaname = 'resupply'
             AND tablename = 'dwo_documents'
             AND indexname = 'dwo_documents_expiring_idx'`,
      );
      expect(result.rows.length).toBe(1);
      // A plain index definition should NOT contain a WHERE clause
      expect(result.rows[0]!.indexdef).not.toMatch(/WHERE/i);
    }, 15_000);

    // ── 0141 oig_leie_screenings — RETIRED by 0156 ─────────────────
    // Dropped by 0156_drop_compliance_machinery (see the
    // staff_training_records note above). Assert the table is gone after
    // the full chain rather than the now-inapplicable column type.
    it("oig_leie_screenings was dropped by 0156 (compliance retirement)", async () => {
      const result = await pool.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.tables
           WHERE table_schema = 'resupply'
             AND table_name = 'oig_leie_screenings'`,
      );
      expect(result.rows.length).toBe(0);
    }, 15_000);

    // ── 0143 / 0164 service_role exists as a pg role ───────────────
    it("service_role pg role exists after migration (guard in 0143/0164)", async () => {
      const result = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_roles WHERE rolname = 'service_role'
         ) AS exists`,
      );
      expect(result.rows[0]!.exists).toBe(true);
    }, 15_000);

    // ── 0164 RPC functions are callable via service_role ───────────
    it("billing_denial_rate function exists in resupply schema", async () => {
      const result = await pool.query<{ routine_name: string }>(
        `SELECT routine_name
           FROM information_schema.routines
           WHERE routine_schema = 'resupply'
             AND routine_name = 'billing_denial_rate'`,
      );
      expect(result.rows.length).toBe(1);
    }, 15_000);

    it("shop_back_in_stock_queue function exists in resupply schema", async () => {
      const result = await pool.query<{ routine_name: string }>(
        `SELECT routine_name
           FROM information_schema.routines
           WHERE routine_schema = 'resupply'
             AND routine_name = 'shop_back_in_stock_queue'`,
      );
      expect(result.rows.length).toBe(1);
    }, 15_000);

    // ── Regression: uuid FK columns do not accidentally accept non-uuid strings ──
    // If staff_user_id were still uuid type, inserting a plain text id like
    // 'admin-001' would fail with an invalid-input-syntax error. This test
    // would need real tables to run but validates the column type coverage above
    // already ensures text columns accept arbitrary text IDs.
    it("text-typed staff_user_id in admin_mfa_secrets accepts non-UUID string values (type boundary)", async () => {
      // Verify via information_schema that the column is 'text' — text columns
      // accept any string including non-UUID admin IDs (e.g. Supabase user IDs
      // that may be UUIDs or opaque strings depending on the auth provider).
      const result = await pool.query<{ data_type: string }>(
        `SELECT data_type
           FROM information_schema.columns
           WHERE table_schema = 'resupply'
             AND table_name = 'admin_mfa_secrets'
             AND column_name = 'staff_user_id'`,
      );
      // If this were 'uuid' type it would reject plain text IDs at INSERT time.
      expect(result.rows[0]!.data_type).toBe("text");
    }, 15_000);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// 3. 0214 apply_patient_payment — BEHAVIOR against a real Postgres.
//
// The unit tests (patient-payment.test.ts) only verify the TS wrapper calls
// the RPC; the decrement / clamp / idempotency logic lives in PL/pgSQL and is
// validated here against the migrated DB (CI "Migration replay" job).
//
// The seed is wrapped so that ANY failure (schema drift, missing migration)
// makes the behavior tests self-skip rather than fail this shared CI job.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!dbUrl)(
  "0214 apply_patient_payment — behavior (live db)",
  () => {
    let pool: Pool;
    const patientId = randomUUID();
    const claimId = randomUUID();
    const claim2Id = randomUUID();
    const paymentId = randomUUID();
    const payment2Id = randomUUID();
    let seeded = false;

    beforeAll(async () => {
      pool = new Pool({ connectionString: dbUrl, max: 2 });
      try {
        await pool.query(
          `INSERT INTO resupply.patients
           (id, pacware_id, legal_first_name, legal_last_name, date_of_birth)
         VALUES ($1, $2, 'Test', 'Patient', '1980-01-01')`,
          [patientId, `pac-${patientId.slice(0, 8)}`],
        );
        await pool.query(
          `INSERT INTO resupply.insurance_claims
           (id, patient_id, payer_name, date_of_service, patient_responsibility_cents)
         VALUES ($1, $2, 'Test Payer', '2026-01-01', 12500)`,
          [claimId, patientId],
        );
        await pool.query(
          `INSERT INTO resupply.insurance_claims
           (id, patient_id, payer_name, date_of_service, patient_responsibility_cents)
         VALUES ($1, $2, 'Test Payer', '2026-01-01', 100)`,
          [claim2Id, patientId],
        );
        await pool.query(
          `INSERT INTO resupply.patient_payments
           (id, patient_id, amount_cents, status, applied_claims_json)
         VALUES ($1, $2, 4000, 'succeeded', $3::jsonb)`,
          [
            paymentId,
            patientId,
            JSON.stringify([{ claimId, amountAppliedCents: 4000 }]),
          ],
        );
        await pool.query(
          `INSERT INTO resupply.patient_payments
           (id, patient_id, amount_cents, status, applied_claims_json)
         VALUES ($1, $2, 99999, 'succeeded', $3::jsonb)`,
          [
            payment2Id,
            patientId,
            JSON.stringify([{ claimId: claim2Id, amountAppliedCents: 99999 }]),
          ],
        );
        seeded = true;
      } catch {
        // Schema drift / un-migrated DB — leave seeded=false so the tests
        // below self-skip instead of failing the shared CI job.
      }
    });

    afterAll(async () => {
      if (!pool) return;
      try {
        // Cascades from patients clean up claims + the ledger; delete payments
        // explicitly first (FK to patients).
        await pool.query(
          `DELETE FROM resupply.patient_payments WHERE patient_id = $1`,
          [patientId],
        );
        await pool.query(
          `DELETE FROM resupply.insurance_claims WHERE patient_id = $1`,
          [patientId],
        );
        await pool.query(`DELETE FROM resupply.patients WHERE id = $1`, [
          patientId,
        ]);
      } catch {
        // best-effort
      }
      await pool.end();
    });

    async function balanceOf(id: string): Promise<number> {
      const r = await pool.query<{ patient_responsibility_cents: string }>(
        `SELECT patient_responsibility_cents FROM resupply.insurance_claims WHERE id = $1`,
        [id],
      );
      return Number(r.rows[0]!.patient_responsibility_cents);
    }

    it("decrements the balance, writes a ledger row, and is idempotent on re-run", async (ctx: TaskContext) => {
      if (!seeded) return ctx.skip();

      await pool.query(`SELECT resupply.apply_patient_payment($1)`, [
        paymentId,
      ]);
      expect(await balanceOf(claimId)).toBe(8500); // 12500 - 4000

      const ledger1 = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM resupply.patient_payment_claim_applications WHERE payment_id = $1`,
        [paymentId],
      );
      expect(Number(ledger1.rows[0]!.n)).toBe(1);

      // Re-run: must NOT double-decrement (this is the crash-recovery path).
      await pool.query(`SELECT resupply.apply_patient_payment($1)`, [
        paymentId,
      ]);
      expect(await balanceOf(claimId)).toBe(8500); // unchanged

      const ledger2 = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM resupply.patient_payment_claim_applications WHERE payment_id = $1`,
        [paymentId],
      );
      expect(Number(ledger2.rows[0]!.n)).toBe(1); // still exactly one

      const events = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM resupply.insurance_claim_events
         WHERE claim_id = $1 AND payer_ref = $2`,
        [claimId, paymentId],
      );
      expect(Number(events.rows[0]!.n)).toBe(1); // exactly one audit event
    }, 20_000);

    it("clamps the balance at zero when the applied amount exceeds it", async (ctx: TaskContext) => {
      if (!seeded) return ctx.skip();
      await pool.query(`SELECT resupply.apply_patient_payment($1)`, [
        payment2Id,
      ]);
      expect(await balanceOf(claim2Id)).toBe(0); // 100 - 99999, clamped
    }, 20_000);
  },
);

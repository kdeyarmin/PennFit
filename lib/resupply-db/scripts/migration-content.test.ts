/**
 * Tests for SQL migration files changed in this PR.
 *
 * Two sections:
 *
 * 1. Static content tests — no database needed. Each test reads the
 *    SQL file from disk and asserts that the correct SQL constructs
 *    are present (and that discarded constructs are absent). These
 *    act as regression guards: if a future edit accidentally reverts
 *    a intentional fix (wrong schema, wrong type, missing DROP DEFAULT,
 *    etc.) the test fails immediately without a live DB.
 *
 * 2. Integration / schema-state tests — skipped automatically when
 *    DATABASE_URL is not set (same pattern as migrate.test.ts). When
 *    a DB is available these tests verify the actual post-migration
 *    schema state: column types, trigger existence, and table presence.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskContext } from "vitest";
import { Pool } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.resolve(__dirname, "../drizzle");

function readMigration(filename: string): string {
  return readFileSync(path.join(DRIZZLE_DIR, filename), "utf-8");
}

// ---------------------------------------------------------------------------
// Section 1: Static SQL content tests (no database required)
// ---------------------------------------------------------------------------

describe("migration SQL content — static checks", () => {
  // -------------------------------------------------------------------------
  // 0060: updated_at triggers phase 4
  // -------------------------------------------------------------------------
  describe("0060_updated_at_triggers_phase4.sql", () => {
    let sql: string;
    beforeAll(() => {
      sql = readMigration("0060_updated_at_triggers_phase4.sql");
    });

    it("targets public.reminder_subscriptions (not resupply.reminder_subscriptions)", () => {
      expect(sql).toMatch(/BEFORE UPDATE ON public\.reminder_subscriptions/);
    });

    it("does NOT reference resupply.reminder_subscriptions in the trigger statement", () => {
      // The trigger line must point to public schema, not the resupply schema
      expect(sql).not.toMatch(/BEFORE UPDATE ON resupply\.reminder_subscriptions/);
    });

    it("still creates the auth trigger on resupply_auth.password_credentials", () => {
      expect(sql).toMatch(/BEFORE UPDATE ON resupply_auth\.password_credentials/);
    });

    it("uses resupply.set_updated_at() function for the reminder_subscriptions trigger", () => {
      // Trigger function must reference the correct schema-qualified function
      expect(sql).toMatch(
        /trg_reminder_subscriptions_set_updated_at[\s\S]*?EXECUTE FUNCTION resupply\.set_updated_at\(\)/,
      );
    });

    it("adds the insurance_leads_status_enum CHECK constraint", () => {
      expect(sql).toMatch(/ADD CONSTRAINT insurance_leads_status_enum/);
      expect(sql).toMatch(/CHECK \(status IN/);
    });
  });

  // -------------------------------------------------------------------------
  // 0061: fulfillments.quantity text → integer
  // -------------------------------------------------------------------------
  describe("0061_fulfillments_quantity_integer.sql", () => {
    let sql: string;
    beforeAll(() => {
      sql = readMigration("0061_fulfillments_quantity_integer.sql");
    });

    it("drops the text default BEFORE altering the column type", () => {
      const dropPos = sql.indexOf("ALTER COLUMN quantity DROP DEFAULT");
      const typePos = sql.indexOf("ALTER COLUMN quantity TYPE integer");
      expect(dropPos).toBeGreaterThan(-1);
      expect(typePos).toBeGreaterThan(-1);
      // DROP DEFAULT must appear before the TYPE change
      expect(dropPos).toBeLessThan(typePos);
    });

    it("uses a USING clause for the type conversion", () => {
      expect(sql).toMatch(/TYPE integer USING quantity::integer/);
    });

    it("sets an integer default of 1 (not the string '1') after the type change", () => {
      // The SET DEFAULT must come after the TYPE change and set numeric 1
      const typePos = sql.indexOf("ALTER COLUMN quantity TYPE integer");
      const defaultPos = sql.indexOf("ALTER COLUMN quantity SET DEFAULT 1");
      expect(defaultPos).toBeGreaterThan(-1);
      expect(defaultPos).toBeGreaterThan(typePos);
    });

    it("targets resupply.fulfillments", () => {
      expect(sql).toMatch(/ALTER TABLE resupply\.fulfillments/);
    });
  });

  // -------------------------------------------------------------------------
  // 0080: staff_training_records
  // -------------------------------------------------------------------------
  describe("0080_staff_training_records.sql", () => {
    let sql: string;
    beforeAll(() => {
      sql = readMigration("0080_staff_training_records.sql");
    });

    it("declares staff_user_id as text (not uuid)", () => {
      // The FK column definition must use text
      expect(sql).toMatch(/"staff_user_id" text NOT NULL/);
    });

    it("does NOT declare staff_user_id as uuid", () => {
      expect(sql).not.toMatch(/"staff_user_id" uuid/);
    });

    it("references resupply.admin_users with ON DELETE CASCADE", () => {
      expect(sql).toMatch(
        /REFERENCES "resupply"\."admin_users"\("id"\) ON DELETE CASCADE/,
      );
    });

    it("creates the table with IF NOT EXISTS guard", () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "resupply"\."staff_training_records"/);
    });

    it("includes the training_type CHECK constraint with all expected values", () => {
      expect(sql).toMatch(/staff_training_records_training_type_enum/);
      const expectedTypes = [
        "hipaa_privacy",
        "hipaa_security",
        "osha_bloodborne",
        "osha_general",
        "infection_control",
        "fit_test",
        "new_hire_orientation",
        "dmepos_supplier_stds",
        "other",
      ];
      for (const t of expectedTypes) {
        expect(sql, `training_type '${t}' must be in the CHECK constraint`).toContain(`'${t}'`);
      }
    });

    it("includes the expiry_after_completion CHECK constraint", () => {
      expect(sql).toMatch(/staff_training_records_expiry_after_completion/);
      expect(sql).toMatch(/"expires_at" IS NULL OR "expires_at" >= "completed_at"/);
    });

    it("creates both indexes for staff lookup and expiry sweep", () => {
      expect(sql).toMatch(/staff_training_records_staff_idx/);
      expect(sql).toMatch(/staff_training_records_expires_type_idx/);
    });
  });

  // -------------------------------------------------------------------------
  // 0084: admin_mfa_secrets
  // -------------------------------------------------------------------------
  describe("0084_admin_mfa_secrets.sql", () => {
    let sql: string;
    beforeAll(() => {
      sql = readMigration("0084_admin_mfa_secrets.sql");
    });

    it("declares staff_user_id as text (not uuid)", () => {
      expect(sql).toMatch(/"staff_user_id" text NOT NULL/);
    });

    it("does NOT declare staff_user_id as uuid", () => {
      expect(sql).not.toMatch(/"staff_user_id" uuid/);
    });

    it("references resupply.admin_users with ON DELETE CASCADE", () => {
      expect(sql).toMatch(
        /REFERENCES "resupply"\."admin_users"\("id"\) ON DELETE CASCADE/,
      );
    });

    it("creates the table with IF NOT EXISTS guard", () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "resupply"\."admin_mfa_secrets"/);
    });

    it("creates a unique index on staff_user_id (one secret per admin)", () => {
      expect(sql).toMatch(/admin_mfa_secrets_staff_user_unique/);
      expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS/);
    });

    it("includes last_used_counter as bigint for replay prevention", () => {
      expect(sql).toMatch(/"last_used_counter" bigint/);
    });
  });

  // -------------------------------------------------------------------------
  // 0085: admin_mfa_recovery_codes
  // -------------------------------------------------------------------------
  describe("0085_admin_mfa_recovery_codes.sql", () => {
    let sql: string;
    beforeAll(() => {
      sql = readMigration("0085_admin_mfa_recovery_codes.sql");
    });

    it("declares staff_user_id as text (not uuid)", () => {
      expect(sql).toMatch(/"staff_user_id" text NOT NULL/);
    });

    it("does NOT declare staff_user_id as uuid", () => {
      expect(sql).not.toMatch(/"staff_user_id" uuid/);
    });

    it("references resupply.admin_users with ON DELETE CASCADE", () => {
      expect(sql).toMatch(
        /REFERENCES "resupply"\."admin_users"\("id"\) ON DELETE CASCADE/,
      );
    });

    it("creates the table with IF NOT EXISTS guard", () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "resupply"\."admin_mfa_recovery_codes"/);
    });

    it("creates a unique index on code_hash for fast lookup and deduplication", () => {
      expect(sql).toMatch(/admin_mfa_recovery_codes_code_hash_unique/);
      expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS/);
    });

    it("stores used_ip as inet (not text) for proper IP address semantics", () => {
      expect(sql).toMatch(/"used_ip" inet/);
    });
  });

  // -------------------------------------------------------------------------
  // 0087: accreditation_policies + admin_policy_attestations
  // -------------------------------------------------------------------------
  describe("0087_accreditation_policies.sql", () => {
    let sql: string;
    beforeAll(() => {
      sql = readMigration("0087_accreditation_policies.sql");
    });

    it("declares staff_user_id in admin_policy_attestations as text (not uuid)", () => {
      // Only admin_policy_attestations has the staff_user_id FK in this file
      expect(sql).toMatch(/"staff_user_id" text NOT NULL REFERENCES "resupply"\."admin_users"/);
    });

    it("does NOT declare staff_user_id as uuid in admin_policy_attestations", () => {
      // accreditation_policies.created_by_user_id IS uuid — filter to the attestations block
      const attestationsBlock = sql.slice(sql.indexOf('"resupply"."admin_policy_attestations"'));
      expect(attestationsBlock).not.toMatch(/"staff_user_id" uuid/);
    });

    it("references admin_users without ON DELETE CASCADE (soft FK for audit history)", () => {
      // The attestations table intentionally omits CASCADE so deleting admin_users
      // does not erase audit history.
      const staffFkLine = sql.match(/"staff_user_id" text NOT NULL REFERENCES[^\n]*/)?.[0];
      expect(staffFkLine).toBeDefined();
      expect(staffFkLine).not.toMatch(/ON DELETE CASCADE/);
    });

    it("creates accreditation_policies with policy_key shape CHECK constraint", () => {
      expect(sql).toMatch(/accreditation_policies_policy_key_shape/);
      expect(sql).toMatch(/\^ *\[a-z0-9_\]/); // regex pattern in CHECK
    });

    it("creates a unique index on (policy_key, version)", () => {
      expect(sql).toMatch(/accreditation_policies_key_version_unique/);
      expect(sql).toMatch(/"policy_key",\s*"version"/);
    });

    it("creates a unique index on (staff_user_id, policy_id) in attestations", () => {
      expect(sql).toMatch(/admin_policy_attestations_staff_policy_unique/);
      expect(sql).toMatch(/"staff_user_id",\s*"policy_id"/);
    });
  });

  // -------------------------------------------------------------------------
  // 0090_admin_mfa_trusted_devices.sql
  // -------------------------------------------------------------------------
  describe("0090_admin_mfa_trusted_devices.sql", () => {
    let sql: string;
    beforeAll(() => {
      sql = readMigration("0090_admin_mfa_trusted_devices.sql");
    });

    it("creates admin_users with IF NOT EXISTS guard (defensive / idempotent)", () => {
      expect(sql).toMatch(
        /CREATE TABLE IF NOT EXISTS "resupply"\."admin_users"/,
      );
    });

    it("defines admin_users.id as text (not uuid) matching 0020 canonical definition", () => {
      expect(sql).toMatch(/"id" text PRIMARY KEY DEFAULT \(gen_random_uuid\(\)::text\)/);
    });

    it("defines admin_users.email_lower as text NOT NULL UNIQUE", () => {
      expect(sql).toMatch(/"email_lower" text NOT NULL UNIQUE/);
    });

    it("includes created_at and updated_at timestamp columns with defaults", () => {
      expect(sql).toMatch(/"created_at" timestamp with time zone NOT NULL DEFAULT now\(\)/);
      expect(sql).toMatch(/"updated_at" timestamp with time zone NOT NULL DEFAULT now\(\)/);
    });

    it("includes the statement-breakpoint comment for migrate.mjs compatibility", () => {
      // The --> statement-breakpoint marker is used by the migration runner
      // to split multi-statement migrations at the correct boundaries.
      expect(sql).toMatch(/-->\s*statement-breakpoint/);
    });

    it("does NOT define any foreign key references (admin_users is a root table)", () => {
      // admin_users is referenced BY other tables; it should not itself
      // hold a FK in this defensive create
      expect(sql).not.toMatch(/REFERENCES/);
    });
  });
});

// ---------------------------------------------------------------------------
// Section 2: Integration / schema-state tests (require DATABASE_URL)
// ---------------------------------------------------------------------------

const dbUrl = process.env.DATABASE_URL;

describe.skipIf(!dbUrl)(
  "migration schema state — integration checks",
  () => {
    let pool: Pool;

    beforeAll(() => {
      pool = new Pool({ connectionString: dbUrl, max: 1 });
    });

    afterAll(async () => {
      await pool.end();
    });

    // -----------------------------------------------------------------------
    // 0060: trigger targeting public.reminder_subscriptions
    // -----------------------------------------------------------------------
    describe("0060 — trigger targets public.reminder_subscriptions", () => {
      it(
        "trg_reminder_subscriptions_set_updated_at exists on public.reminder_subscriptions",
        async (ctx: TaskContext) => {
          const res = await pool.query<{ tgname: string }>(
            `SELECT tgname
               FROM pg_trigger t
               JOIN pg_class c ON c.oid = t.tgrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public'
                AND c.relname = 'reminder_subscriptions'
                AND t.tgname = 'trg_reminder_subscriptions_set_updated_at'`,
          );
          if (res.rows.length === 0) {
            ctx.skip(
              "public.reminder_subscriptions does not exist on this DB — " +
                "the storefront schema may not be deployed here.",
            );
            return;
          }
          expect(res.rows[0]?.tgname).toBe(
            "trg_reminder_subscriptions_set_updated_at",
          );
        },
        30_000,
      );

      it(
        "trg_reminder_subscriptions_set_updated_at does NOT exist on resupply.reminder_subscriptions",
        async (ctx: TaskContext) => {
          const res = await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count
               FROM pg_trigger t
               JOIN pg_class c ON c.oid = t.tgrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'resupply'
                AND c.relname = 'reminder_subscriptions'
                AND t.tgname = 'trg_reminder_subscriptions_set_updated_at'`,
          );
          // If resupply.reminder_subscriptions doesn't exist at all, count=0 is fine.
          expect(Number(res.rows[0]!.count)).toBe(0);
        },
        30_000,
      );
    });

    // -----------------------------------------------------------------------
    // 0061: fulfillments.quantity column type
    // -----------------------------------------------------------------------
    describe("0061 — fulfillments.quantity is integer", () => {
      it(
        "fulfillments.quantity has data_type 'integer'",
        async (ctx: TaskContext) => {
          const res = await pool.query<{
            data_type: string;
            column_default: string | null;
          }>(
            `SELECT data_type, column_default
               FROM information_schema.columns
              WHERE table_schema = 'resupply'
                AND table_name = 'fulfillments'
                AND column_name = 'quantity'`,
          );
          if (res.rows.length === 0) {
            ctx.skip("resupply.fulfillments does not exist on this DB.");
            return;
          }
          expect(res.rows[0]!.data_type).toBe("integer");
        },
        30_000,
      );

      it(
        "fulfillments.quantity default is 1 (integer literal, not text '1')",
        async (ctx: TaskContext) => {
          const res = await pool.query<{ column_default: string | null }>(
            `SELECT column_default
               FROM information_schema.columns
              WHERE table_schema = 'resupply'
                AND table_name = 'fulfillments'
                AND column_name = 'quantity'`,
          );
          if (res.rows.length === 0) {
            ctx.skip("resupply.fulfillments does not exist on this DB.");
            return;
          }
          // Postgres stores integer default as '1' in information_schema but
          // without the text cast expression that was there before migration.
          // Critically, it must NOT be the text expression "'1'::text".
          const colDefault = res.rows[0]!.column_default;
          expect(colDefault).not.toMatch(/'1'::text/);
          expect(colDefault).not.toBeNull();
        },
        30_000,
      );
    });

    // -----------------------------------------------------------------------
    // 0080/0084/0085/0087: staff_user_id FK columns are text
    // -----------------------------------------------------------------------
    const staffUserIdTables: Array<{ table: string; schema: string }> = [
      { schema: "resupply", table: "staff_training_records" },
      { schema: "resupply", table: "admin_mfa_secrets" },
      { schema: "resupply", table: "admin_mfa_recovery_codes" },
      { schema: "resupply", table: "admin_policy_attestations" },
    ];

    for (const { schema, table } of staffUserIdTables) {
      describe(`${table} — staff_user_id column type`, () => {
        it(
          `${schema}.${table}.staff_user_id is data_type 'text' (not 'uuid')`,
          async (ctx: TaskContext) => {
            const res = await pool.query<{ data_type: string }>(
              `SELECT data_type
                 FROM information_schema.columns
                WHERE table_schema = $1
                  AND table_name = $2
                  AND column_name = 'staff_user_id'`,
              [schema, table],
            );
            if (res.rows.length === 0) {
              ctx.skip(`${schema}.${table} does not exist on this DB.`);
              return;
            }
            expect(res.rows[0]!.data_type).toBe("text");
          },
          30_000,
        );
      });
    }

    // -----------------------------------------------------------------------
    // 0087: admin_policy_attestations — FK to admin_users without CASCADE
    // -----------------------------------------------------------------------
    describe("0087 — admin_policy_attestations soft FK to admin_users", () => {
      it(
        "FK from admin_policy_attestations.staff_user_id to admin_users has no CASCADE delete rule",
        async (ctx: TaskContext) => {
          const res = await pool.query<{ delete_rule: string }>(
            `SELECT rc.delete_rule
               FROM information_schema.referential_constraints rc
               JOIN information_schema.key_column_usage kcu
                 ON kcu.constraint_name = rc.constraint_name
                AND kcu.constraint_schema = rc.constraint_schema
              WHERE kcu.table_schema = 'resupply'
                AND kcu.table_name = 'admin_policy_attestations'
                AND kcu.column_name = 'staff_user_id'`,
          );
          if (res.rows.length === 0) {
            ctx.skip(
              "resupply.admin_policy_attestations FK not found — table may not exist.",
            );
            return;
          }
          // Should be 'NO ACTION' or 'RESTRICT', not 'CASCADE'
          expect(res.rows[0]!.delete_rule).not.toBe("CASCADE");
        },
        30_000,
      );
    });

    // -----------------------------------------------------------------------
    // 0090: defensive admin_users table creation
    // -----------------------------------------------------------------------
    describe("0090 — admin_users table exists", () => {
      it(
        "resupply.admin_users table is present in the schema",
        async () => {
          const res = await pool.query<{ exists: boolean }>(
            `SELECT EXISTS (
               SELECT 1
                 FROM information_schema.tables
                WHERE table_schema = 'resupply'
                  AND table_name = 'admin_users'
             ) AS exists`,
          );
          expect(res.rows[0]?.exists).toBe(true);
        },
        30_000,
      );

      it(
        "resupply.admin_users.id is text (not uuid) with a non-null default",
        async (ctx: TaskContext) => {
          const res = await pool.query<{
            data_type: string;
            column_default: string | null;
          }>(
            `SELECT data_type, column_default
               FROM information_schema.columns
              WHERE table_schema = 'resupply'
                AND table_name = 'admin_users'
                AND column_name = 'id'`,
          );
          if (res.rows.length === 0) {
            ctx.skip("resupply.admin_users does not exist on this DB.");
            return;
          }
          expect(res.rows[0]!.data_type).toBe("text");
          expect(res.rows[0]!.column_default).toMatch(/gen_random_uuid/);
        },
        30_000,
      );

      it(
        "resupply.admin_users.email_lower is text NOT NULL",
        async (ctx: TaskContext) => {
          const res = await pool.query<{
            data_type: string;
            is_nullable: string;
          }>(
            `SELECT data_type, is_nullable
               FROM information_schema.columns
              WHERE table_schema = 'resupply'
                AND table_name = 'admin_users'
                AND column_name = 'email_lower'`,
          );
          if (res.rows.length === 0) {
            ctx.skip("resupply.admin_users does not exist on this DB.");
            return;
          }
          expect(res.rows[0]!.data_type).toBe("text");
          expect(res.rows[0]!.is_nullable).toBe("NO");
        },
        30_000,
      );
    });
  },
);

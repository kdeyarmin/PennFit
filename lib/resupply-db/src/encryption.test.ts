import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import {
  decrypt,
  decryptJson,
  encrypt,
  encryptJson,
} from "./encryption";
import { patients } from "./schema/patients";

const { Pool } = pg;

/**
 * pgcrypto round-trip integration test.
 *
 * Skipped automatically if neither DATABASE_URL nor RESUPPLY_DATA_KEY is
 * available — this lets the package's `test` script run cleanly on a
 * clean checkout without a live Postgres / key.
 */
const dbUrl = process.env.DATABASE_URL;
const dataKey = process.env.RESUPPLY_DATA_KEY;
const canRun = Boolean(dbUrl && dataKey);

const describeIfDb = canRun ? describe : describe.skip;

describeIfDb("pgcrypto round-trip", () => {
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl });
    db = drizzle(pool);

    // pgcrypto must be installed for `pgp_sym_encrypt` / `pgp_sym_decrypt`.
    await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    // The schema is created by `drizzle-kit push`; for tests we make sure
    // it exists in case `push` has not been run yet.
    await pool.query("CREATE SCHEMA IF NOT EXISTS resupply");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("round-trips a text PHI column through pgcrypto", async () => {
    const pacwareId = `pgcrypto-test-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;

    const inserted = await db
      .insert(patients)
      .values({
        pacwareId,
        legalFirstName: encrypt("Robin"),
        legalLastName: encrypt("O'Hara"),
        dateOfBirth: encrypt("1962-04-12"),
        phoneE164: encrypt("+12155550199"),
        email: encrypt("robin@example.com"),
        address: encryptJson({
          line1: "123 Market St",
          city: "Philadelphia",
          state: "PA",
          postalCode: "19103",
          country: "US",
        }),
      })
      .returning({ id: patients.id });

    const id = inserted[0]!.id;

    try {
      const rows = await db
        .select({
          id: patients.id,
          firstName: decrypt(patients.legalFirstName),
          lastName: decrypt(patients.legalLastName),
          dob: decrypt(patients.dateOfBirth),
          phone: decrypt(patients.phoneE164),
          email: decrypt(patients.email),
          address: decryptJson<{
            line1: string;
            city: string;
            state: string;
            postalCode: string;
            country: string;
          }>(patients.address),
        })
        .from(patients)
        .where(eq(patients.id, id));

      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.firstName).toBe("Robin");
      expect(row.lastName).toBe("O'Hara");
      expect(row.dob).toBe("1962-04-12");
      expect(row.phone).toBe("+12155550199");
      expect(row.email).toBe("robin@example.com");
      expect(row.address).toEqual({
        line1: "123 Market St",
        city: "Philadelphia",
        state: "PA",
        postalCode: "19103",
        country: "US",
      });

      // And confirm the on-disk bytes are NOT plaintext — the column
      // should look like a pgcrypto blob (starts with 0xC3 for OpenPGP
      // packet headers).
      const raw = await pool.query<{ legal_first_name: Buffer }>(
        "SELECT legal_first_name FROM resupply.patients WHERE id = $1",
        [id],
      );
      const cipher = raw.rows[0]!.legal_first_name;
      expect(Buffer.isBuffer(cipher)).toBe(true);
      expect(cipher.length).toBeGreaterThan("Robin".length);
      expect(cipher.toString("utf8")).not.toContain("Robin");
    } finally {
      await db.delete(patients).where(eq(patients.id, id));
    }
  });

  it("encrypt(null) writes SQL NULL", async () => {
    const pacwareId = `pgcrypto-null-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;

    const inserted = await db
      .insert(patients)
      .values({
        pacwareId,
        legalFirstName: encrypt("X"),
        legalLastName: encrypt("Y"),
        dateOfBirth: encrypt("2000-01-01"),
        phoneE164: encrypt(null),
        email: encrypt(null),
      })
      .returning({ id: patients.id });

    const id = inserted[0]!.id;

    try {
      const rows = await pool.query<{ phone_e164: Buffer | null }>(
        "SELECT phone_e164 FROM resupply.patients WHERE id = $1",
        [id],
      );
      expect(rows.rows[0]!.phone_e164).toBeNull();
    } finally {
      await db.delete(patients).where(eq(patients.id, id));
    }
  });

  it("refuses to encrypt or decrypt when no data key is configured", () => {
    // Need both env vars cleared — `getDataKey()` falls back to
    // RESUPPLY_MASTER_KEY when RESUPPLY_DATA_KEY is absent, so to
    // exercise the throw we have to ensure neither is set.
    const originalKey = process.env.RESUPPLY_DATA_KEY;
    const originalMaster = process.env.RESUPPLY_MASTER_KEY;
    delete process.env.RESUPPLY_DATA_KEY;
    delete process.env.RESUPPLY_MASTER_KEY;
    try {
      expect(() => encrypt("anything")).toThrow(/RESUPPLY_DATA_KEY/);
      expect(() => decrypt(sql`'\\x00'::bytea`)).toThrow(/RESUPPLY_DATA_KEY/);
    } finally {
      if (originalKey === undefined) delete process.env.RESUPPLY_DATA_KEY;
      else process.env.RESUPPLY_DATA_KEY = originalKey;
      if (originalMaster === undefined) delete process.env.RESUPPLY_MASTER_KEY;
      else process.env.RESUPPLY_MASTER_KEY = originalMaster;
    }
  });
});

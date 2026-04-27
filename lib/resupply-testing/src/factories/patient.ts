import { faker } from "@faker-js/faker";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { encrypt, encryptJson, patients } from "@workspace/resupply-db";

// Drizzle's `$inferInsert` collapses each column to its `data` type
// (string for `encryptedText`), but `db.insert(...).values({...})`
// actually accepts `data | SQL<data>`. `PgInsertValue<typeof patients>`
// is the latter — using it lets factories return values still wrapped in
// the `encrypt()` SQL fragment without forcing every test to re-cast.
type PatientInsertValue = PgInsertValue<typeof patients>;

// Factories for the resupply schema. Every factory:
//   1. Returns an `InsertXRow` ready to drop into `db.insert(table).values(...)`.
//   2. Wraps PHI fields in `encrypt()` / `encryptJson()` so callers cannot
//      forget. Tests that hand-roll inserts are how you accidentally write
//      plaintext PHI to a `bytea` column.
//   3. Accepts a `Partial<XFixtureSpec>` of *plain* values (string,
//      object, etc) — the factory does the encryption. This keeps test
//      sites readable: `makePatient({ legalFirstName: "Alice" })`, not
//      `{ legalFirstName: encrypt("Alice") }`.
//   4. Fills any field the test didn't specify with a faker-generated
//      value drawn from a deterministic seedable RNG (faker is already a
//      dep). Operational fields (status, timestamps) get sane defaults.
//   5. Defaults `pacwareId` to a unique-per-call string so back-to-back
//      `makePatient()` calls don't collide on the unique index.

export interface PatientFixtureSpec {
  pacwareId: string;
  legalFirstName: string;
  legalLastName: string;
  /** YYYY-MM-DD */
  dateOfBirth: string;
  phoneE164: string | null;
  email: string | null;
  address: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  } | null;
  status: "active" | "paused" | "closed";
}

export function makePatient(
  overrides: Partial<PatientFixtureSpec> = {},
): PatientInsertValue {
  const spec: PatientFixtureSpec = {
    pacwareId:
      overrides.pacwareId ??
      `pac-${faker.string.alphanumeric({ length: 10, casing: "lower" })}`,
    legalFirstName: overrides.legalFirstName ?? faker.person.firstName(),
    legalLastName: overrides.legalLastName ?? faker.person.lastName(),
    dateOfBirth:
      overrides.dateOfBirth ??
      faker.date
        .birthdate({ min: 30, max: 90, mode: "age" })
        .toISOString()
        .slice(0, 10),
    phoneE164:
      overrides.phoneE164 === undefined
        ? `+1${faker.string.numeric(10)}`
        : overrides.phoneE164,
    email:
      overrides.email === undefined
        ? faker.internet.email().toLowerCase()
        : overrides.email,
    address:
      overrides.address === undefined
        ? {
            line1: faker.location.streetAddress(),
            city: faker.location.city(),
            state: faker.location.state({ abbreviated: true }),
            postalCode: faker.location.zipCode("#####"),
            country: "US",
          }
        : overrides.address,
    status: overrides.status ?? "active",
  };

  return {
    pacwareId: spec.pacwareId,
    legalFirstName: encrypt(spec.legalFirstName),
    legalLastName: encrypt(spec.legalLastName),
    dateOfBirth: encrypt(spec.dateOfBirth),
    phoneE164: encrypt(spec.phoneE164),
    email: encrypt(spec.email),
    address: encryptJson(spec.address),
    status: spec.status,
  };
}

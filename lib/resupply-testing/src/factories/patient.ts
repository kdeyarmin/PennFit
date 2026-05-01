import { faker } from "@faker-js/faker";
import { patients, type InsertPatientRow } from "@workspace/resupply-db";

// Factories for the resupply schema. Every factory:
//   1. Returns an `InsertPatientRow` ready to drop into `db.insert(table).values(...)`.
//   2. Accepts a `Partial<PatientFixtureSpec>` of plain values — the
//      factory wires them straight into the row. PHI columns are
//      plain `text`/`jsonb` post-migration 0025; there is no
//      encryption wrapping any more.
//   3. Fills any field the test didn't specify with a faker-generated
//      value drawn from a deterministic seedable RNG (faker is already a
//      dep). Operational fields (status, timestamps) get sane defaults.
//   4. Defaults `pacwareId` to a unique-per-call string so back-to-back
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

// Reference `patients` so the import is exercised — the schema export
// is the source of truth for the row shape and we want a hard error
// here if the schema name ever changes.
void patients;

export function makePatient(
  overrides: Partial<PatientFixtureSpec> = {},
): InsertPatientRow {
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
    legalFirstName: spec.legalFirstName,
    legalLastName: spec.legalLastName,
    dateOfBirth: spec.dateOfBirth,
    phoneE164: spec.phoneE164,
    email: spec.email,
    address: spec.address,
    status: spec.status,
  };
}

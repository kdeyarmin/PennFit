import { faker } from "@faker-js/faker";
import { prescriptions, type InsertPrescriptionRow } from "@workspace/resupply-db";

void prescriptions;

// CPAP-flavored item SKUs the eligibility engine will look for. The
// list is short on purpose — the schema doesn't manage a catalogue, so
// tests only need a handful of realistic strings.
const SKU_POOL = [
  "MASK-NASAL-MED",
  "MASK-FULL-LRG",
  "TUBING-STD-6FT",
  "FILTER-DISP-PK6",
  "HUMIDIFIER-CHAMBER",
] as const;

export interface PrescriptionFixtureSpec {
  itemSku: string;
  cadenceDays: number;
  /** YYYY-MM-DD */
  validFrom: string;
  /** YYYY-MM-DD or null for open-ended scripts */
  validUntil: string | null;
  details: {
    prescriberName?: string;
    prescriberNpi?: string;
    diagnosis?: string;
    notes?: string;
  } | null;
  status: "active" | "expired" | "revoked";
}

export function makePrescription(
  args: { patientId: string } & Partial<PrescriptionFixtureSpec>,
): InsertPrescriptionRow {
  const {
    patientId,
    itemSku,
    cadenceDays,
    validFrom,
    validUntil,
    details,
    status,
  } = args;

  const spec: PrescriptionFixtureSpec = {
    itemSku: itemSku ?? faker.helpers.arrayElement(SKU_POOL),
    cadenceDays:
      cadenceDays ?? faker.helpers.arrayElement([30, 60, 90, 180]),
    validFrom:
      validFrom ?? faker.date.recent({ days: 60 }).toISOString().slice(0, 10),
    validUntil:
      validUntil === undefined
        ? faker.date.future({ years: 1 }).toISOString().slice(0, 10)
        : validUntil,
    details:
      details === undefined
        ? {
            prescriberName: `${faker.person.firstName()} ${faker.person.lastName()}, MD`,
            prescriberNpi: faker.string.numeric(10),
            diagnosis: "G47.33 — Obstructive sleep apnea",
            notes: "Standard CPAP resupply per AASM guidelines.",
          }
        : details,
    status: status ?? "active",
  };

  return {
    patientId,
    itemSku: spec.itemSku,
    cadenceDays: spec.cadenceDays,
    validFrom: spec.validFrom,
    validUntil: spec.validUntil,
    details: spec.details,
    status: spec.status,
  };
}

import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

/**
 * providers — the central registry of physicians, nurse practitioners,
 * and other clinicians who prescribe CPAP therapy for our patients.
 *
 * Why this table exists
 * ---------------------
 * Until now, prescriber data lived as free-text JSONB on prescriptions
 * (`details.prescriberName`, `details.prescriberNpi`) and on
 * `shop_customers.physician_info_json`. That's fine for "record what
 * the patient told us"; it's bad for anything else: NPIs end up
 * misspelled, the same physician fans out into a dozen rows under
 * subtly different names, and we can't surface "every patient under
 * Dr. Smith" or "every Rx ever issued by NPI 1234567893" without a
 * tour of dozens of jsonb fields.
 *
 * This table normalizes the prescriber concept so:
 *   * Each provider exists once, identified by NPI (the national,
 *     deduplicated, non-PHI key).
 *   * Prescriptions FK to a provider instead of carrying duplicate
 *     jsonb strings.
 *   * The fax outreach / Rx renewal flows already in physician_fax_
 *     outreach can target a stable provider ID.
 *   * The Standard Written Order (SWO) generator and 90-day Medicare
 *     compliance attestation PDF have a single, queryable source for
 *     prescriber identity.
 *
 * NPI vs name as the unique key
 * -----------------------------
 * NPI (National Provider Identifier) is a 10-digit number assigned by
 * CMS through NPPES, the national registry. It's non-PHI (it's a
 * professional identifier, like a license plate, not a patient
 * identifier), publicly searchable at https://npiregistry.cms.hhs.gov,
 * and globally unique per clinician. Using NPI as the unique key
 * dedupes "Dr. John Smith MD" and "John Smith, M.D." automatically
 * across spelling drift. We keep `npi` UNIQUE; `legal_name` is just
 * the canonical display form. A provider WITHOUT an NPI (legacy
 * jsonb data that the backfill couldn't resolve) lives in a separate
 * `npi_pending` queue that CSRs work — we never insert a NULL-NPI
 * provider row through the normal write path.
 *
 * PHI posture
 * -----------
 * Provider data is NOT PHI — it's the clinician's professional
 * directory entry. We don't store license numbers, SSN, DEA, or any
 * identifier that could re-identify the provider as an individual
 * patient (clinicians can themselves be patients of other DMEs;
 * that's not the data we keep here).
 *
 * `source` enum
 * -------------
 * Where this row came from:
 *   * `nppes` — verified against the public NPI registry at the
 *     timestamp in `verified_at`. Authoritative.
 *   * `csr_entry` — typed in by a CSR. Treat as authoritative-ish
 *     until a `nppes` verification overwrites it.
 *   * `backfill` — synthesized from existing jsonb prescriber data
 *     during the providers-rollout migration. Lowest trust — the CSR
 *     review queue surfaces these for confirmation.
 *
 * Indexes
 * -------
 *   * `providers_npi_unique` — UNIQUE on npi. NPI lookups (every
 *     prescription create, every PA submission) must be exact-match
 *     and fast.
 *   * `providers_legal_name_idx` — supports "search providers by
 *     name" in the admin lookup bar without a full table scan once
 *     the directory grows.
 */
export const providers = resupplySchema.table(
  "providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // 10-digit NPI. Stored as text (not integer) to preserve any
    // leading zeros and to avoid the "is this a number or a string"
    // ambiguity at every API boundary.
    npi: varchar("npi", { length: 10 }).notNull(),

    legalName: text("legal_name").notNull(),

    // Provider taxonomy code (e.g. "207RP1001X" for Pulmonary
    // Disease). Optional — most CPAP-prescribing providers are
    // pulmonologists, sleep-medicine specialists, or PCPs, but the
    // SWO doesn't require taxonomy.
    taxonomyCode: varchar("taxonomy_code", { length: 16 }),

    // E.164 phone and fax. Same format as patients.phone_e164 so the
    // same Twilio outreach path can dial them.
    phoneE164: varchar("phone_e164", { length: 16 }),
    faxE164: varchar("fax_e164", { length: 16 }),

    email: text("email"),

    // Practice address as JSONB. Same shape as patients.address —
    // single canonical Address subset (line1, line2, city, state,
    // postalCode, country). Provider may operate at multiple
    // practice locations; this is the primary mailing address that
    // appears on the SWO and on outbound fax cover sheets. Multiple-
    // location support would be a separate provider_locations table.
    practiceAddress: jsonb("practice_address").$type<{
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      postalCode?: string;
      country?: string;
    } | null>(),

    // Free-text practice name ("Penn Sleep Center", "Mid-Atlantic
    // Pulmonary Associates"). Useful on the SWO header.
    practiceName: text("practice_name"),

    // Provenance for the row's authority. See class comment.
    source: text("source", { enum: ["nppes", "csr_entry", "backfill"] })
      .notNull()
      .default("csr_entry"),

    // Stamp of the most recent successful NPPES verification of this
    // row's legal_name / taxonomy / address. NULL means "never
    // verified" — UI should surface a "verify" CTA in that state.
    verifiedAt: timestamp("verified_at", { withTimezone: true }),

    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    npiUnique: uniqueIndex("providers_npi_unique").on(t.npi),
    legalNameIdx: index("providers_legal_name_idx").on(t.legalName),
  }),
);

export type ProviderRow = typeof providers.$inferSelect;
export type InsertProviderRow = typeof providers.$inferInsert;
export type ProviderSource = NonNullable<ProviderRow["source"]>;

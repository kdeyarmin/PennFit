// Provider auto-matcher for inbound referrals.
//
// Strategy (in order):
//   1. exact_npi   — providers.npi = order.provider.npi (LOCAL DB)
//   2. nppes_lookup — when the NPI isn't already in our providers
//                     table, hit NPPES; on a hit, INSERT a new
//                     providers row + return its id. This gives us
//                     a real provider record the CSR can reference
//                     immediately without a side trip to /admin/providers.
//
// We only ever auto-create providers from NPPES — never from
// untrusted referral payload strings. A clinic name we got from
// Parachute may not match the NPPES legal name; we trust NPPES as
// the source of record.
//
// PHI posture: NPIs and NPPES projections are NOT PHI (CMS public
// registry). Safe to log.

import { logger } from "../logger";
import {
  lookupNpi,
  NppesLookupError,
  type NppesProviderProjection,
} from "../nppes";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

export type ProviderMatchKind = "exact_npi" | "nppes_lookup" | "none";

export interface ProviderMatchInput {
  /** 10 digits or null. Normalised by parse-order.ts. */
  npi: string | null;
  /**
   * Optional injection point for tests so they don't have to
   * monkey-patch global fetch.
   */
  nppesLookup?: typeof lookupNpi;
}

export interface ProviderMatchResult {
  providerId: string | null;
  kind: ProviderMatchKind;
}

export async function matchProvider(
  input: ProviderMatchInput,
): Promise<ProviderMatchResult> {
  if (!input.npi) {
    return { providerId: null, kind: "none" };
  }
  const supabase = getSupabaseServiceRoleClient();

  // 1. exact_npi — local DB.
  const { data: local } = await supabase
    .schema("resupply")
    .from("providers")
    .select("id")
    .eq("npi", input.npi)
    .limit(1)
    .maybeSingle();
  if (local) {
    return { providerId: local.id, kind: "exact_npi" };
  }

  // 2. NPPES fallback.
  const lookup = input.nppesLookup ?? lookupNpi;
  let projection: NppesProviderProjection | null;
  try {
    projection = await lookup(input.npi);
  } catch (err) {
    if (err instanceof NppesLookupError) {
      logger.info(
        { npi: input.npi, err: err.message },
        "inbound_referral.match_provider.nppes_unavailable",
      );
    } else {
      logger.warn(
        {
          npi: input.npi,
          error: err instanceof Error ? err.message : String(err),
        },
        "inbound_referral.match_provider.nppes_unexpected_error",
      );
    }
    return { providerId: null, kind: "none" };
  }
  if (!projection) {
    return { providerId: null, kind: "none" };
  }

  // NPPES hit — INSERT a providers row (idempotent on npi UNIQUE).
  // source='nppes' is the allowed enum value for auto-created rows
  // (CHECK constraint in 0071_providers.sql).
  const { data: inserted, error: insertErr } = await supabase
    .schema("resupply")
    .from("providers")
    .insert({
      npi: projection.npi,
      legal_name: projection.legalName,
      taxonomy_code: projection.taxonomyCode,
      phone_e164: projection.phoneE164,
      fax_e164: projection.faxE164,
      practice_name: projection.practiceName,
      // PostgREST treats `jsonb` columns as `Json` in the generated
      // types. The projection ships a typed object; cast to the
      // structural `Json` shape rather than the looser `object` so
      // the insert payload typechecks against the table's Insert
      // type.
      practice_address:
        projection.practiceAddress as unknown as import("@workspace/resupply-db").Database["resupply"]["Tables"]["providers"]["Row"]["practice_address"],
      source: "nppes",
      verified_at: new Date().toISOString(),
    })
    .select("id")
    .maybeSingle();

  if (insertErr) {
    // 23505 = race with another dispatcher / a CSR create flow. Re-
    // select to grab the now-existing row.
    if (typeof insertErr.code === "string" && insertErr.code === "23505") {
      const { data: raced } = await supabase
        .schema("resupply")
        .from("providers")
        .select("id")
        .eq("npi", projection.npi)
        .limit(1)
        .maybeSingle();
      if (raced) {
        return { providerId: raced.id, kind: "nppes_lookup" };
      }
    }
    logger.warn(
      { npi: projection.npi, err_code: insertErr.code },
      "inbound_referral.match_provider.insert_failed",
    );
    return { providerId: null, kind: "none" };
  }

  if (!inserted) {
    return { providerId: null, kind: "none" };
  }
  return { providerId: inserted.id, kind: "nppes_lookup" };
}

// Resolve the payer_profile that a parsed 835 came from.
//
// The 835 envelope carries:
//   - N1*PR with the payer's name (parse-835.ts: `payerName`)
//   - N1*PR with REF*2U or N1*PR*<id> with a payer id (`payerId`)
//
// We try, in priority order:
//   1. payer_profiles.era_payer_id = parsedEra.payerId
//      — Phase 12 added era_payer_id specifically for the case where
//        the 835 receive-side id differs from the 837 send-side id.
//   2. payer_profiles.office_ally_payer_id = parsedEra.payerId
//      — fallback for catalog rows whose ERA id matches the OA send id.
//   3. payer_profiles.edi_5010_payer_id = parsedEra.payerId
//      — final id-based fallback.
//   4. payer_profiles.display_name ILIKE parsedEra.payerName
//      — name match when the 835 carries no usable id (rare; some
//        Medicaid MCOs ship the 835 with payerName only).
//
// Returns null when none match. The caller persists payer_profile_id
// = null so the ingest dashboard flags it for catalog backfill.

import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../logger";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;
type PayerRow = Database["resupply"]["Tables"]["payer_profiles"]["Row"];

export interface EraPayerHints {
  payerId: string | null;
  payerName: string | null;
}

export interface ResolvedEraPayer {
  payerProfileId: string;
  matchReason: "era_payer_id" | "office_ally_payer_id" | "edi_5010_payer_id" | "name_ilike";
}

export async function resolvePayerProfileForEra(
  hints: EraPayerHints,
  opts: { supabase?: SupabaseClient } = {},
): Promise<ResolvedEraPayer | null> {
  const supabase = opts.supabase ?? getSupabaseServiceRoleClient();

  const id = (hints.payerId ?? "").trim();
  const name = (hints.payerName ?? "").trim();

  if (id) {
    const byEra = await lookup(supabase, "era_payer_id", id);
    if (byEra) {
      return { payerProfileId: byEra.id, matchReason: "era_payer_id" };
    }
    const byOa = await lookup(supabase, "office_ally_payer_id", id);
    if (byOa) {
      return {
        payerProfileId: byOa.id,
        matchReason: "office_ally_payer_id",
      };
    }
    const byEdi = await lookup(supabase, "edi_5010_payer_id", id);
    if (byEdi) {
      return {
        payerProfileId: byEdi.id,
        matchReason: "edi_5010_payer_id",
      };
    }
  }

  if (name) {
    const { data, error } = await supabase
      .schema("resupply")
      .from("payer_profiles")
      .select("id")
      .ilike("display_name", name)
      .eq("is_active", true)
      .limit(1);
    if (error) {
      logger.warn(
        { err: error.message, payerName: name },
        "resolvePayerProfileForEra: name lookup failed",
      );
      return null;
    }
    const first = data?.[0];
    if (first) {
      return { payerProfileId: first.id, matchReason: "name_ilike" };
    }
  }
  return null;
}

async function lookup(
  supabase: SupabaseClient,
  column: "era_payer_id" | "office_ally_payer_id" | "edi_5010_payer_id",
  value: string,
): Promise<Pick<PayerRow, "id"> | null> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("payer_profiles")
    .select("id")
    .eq(column, value)
    .eq("is_active", true)
    .limit(1);
  if (error) {
    logger.warn(
      { err: error.message, column, value },
      "resolvePayerProfileForEra: lookup failed",
    );
    return null;
  }
  return data?.[0] ?? null;
}

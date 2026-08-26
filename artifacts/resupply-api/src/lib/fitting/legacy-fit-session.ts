/**
 * Create a lightweight `fit_sessions` row for a legacy (non-clinical)
 * fitter request so closing as `fulfilled` can stamp dispense.
 *
 * `/api/recommend` is deliberately stateless (no DB write). The clinical
 * `/api/fit/assess` path already persists a session. Without this helper,
 * a lead-capture request filed from the legacy engine has
 * `fit_session_id = null`, and the fulfilled close silently skips
 * `markFitSessionDispensedById` — the outcomes dashboard's dispense rate
 * stays zero for that whole path.
 *
 * The row is marked `degraded: true` so staff know it was not produced by
 * the clinical engine. Fail-soft: a session insert blip must not block
 * filing the patient's request.
 */

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../logger";
import { RULES_ENGINE_VERSION } from "./versions";

export async function createLegacyFitSessionForRequest(input: {
  orgId: string;
  population: "adult" | "pediatric";
  recommendedMaskId?: string | null;
  recommendedMaskName?: string | null;
  recommendedMaskType?: string | null;
  recommendedMaskSize?: string | null;
}): Promise<string | null> {
  try {
    const supabase = getOrgScopedClient(input.orgId);

    let primaryMaskModelId: string | null = null;
    if (input.recommendedMaskId) {
      const { data, error: lookupErr } = (await supabase
        .raw()
        .schema("resupply")
        .from("mask_models")
        .select("id")
        .or(`org_id.is.null,org_id.eq.${input.orgId}`)
        .eq("slug", input.recommendedMaskId)
        .order("org_id", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle()) as {
        data: { id?: string } | null;
        error: { message: string } | null;
      };
      if (lookupErr) {
        logger.warn(
          {
            event: "legacy_fit_session_mask_lookup_failed",
            err: lookupErr.message,
          },
          "legacy fit session: mask slug lookup failed; continuing without FK",
        );
      } else {
        primaryMaskModelId = data?.id ?? null;
      }
    }

    const { data, error } = await supabase
      .from("fit_sessions")
      .insert({
        entry_point: "remote_link",
        population: input.population,
        service_line: "pap",
        status: "recommended",
        outcome: "high_confidence",
        rules_engine_version: RULES_ENGINE_VERSION,
        // Legacy recommend path — no clinical assess / formulary snapshot.
        degraded: true,
        review_status: "not_required",
        primary_mask_model_id: primaryMaskModelId,
        // Leave alternatives unset (null) so sessionOfferedMask treats a
        // missing snapshot as legacy-permissive when the FK did not resolve.
        primary_recommendation: input.recommendedMaskId
          ? {
              maskId: input.recommendedMaskId,
              maskSlug: input.recommendedMaskId,
              name: input.recommendedMaskName ?? null,
              type: input.recommendedMaskType ?? null,
              size: input.recommendedMaskSize ?? null,
            }
          : null,
      })
      .select("id")
      .single();

    if (error || !data) {
      logger.warn(
        {
          event: "legacy_fit_session_insert_failed",
          message: error?.message ?? "no row returned",
        },
        "legacy fit session: insert failed; fit request will proceed without a session link",
      );
      return null;
    }
    return String((data as { id: string }).id);
  } catch (err) {
    logger.warn(
      {
        event: "legacy_fit_session_insert_failed",
        err: err instanceof Error ? err.message : String(err),
      },
      "legacy fit session: insert threw; fit request will proceed without a session link",
    );
    return null;
  }
}

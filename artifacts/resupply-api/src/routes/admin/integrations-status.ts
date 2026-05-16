// /admin/integrations/status — per-vendor adapter availability +
// recent fetch health.
//
// Returns:
//   adapters: [{
//     source,
//     availability: { status: "configured" | "stub" | "unavailable", reason? },
//     recentSnapshots: { ok: N, error: N },
//     errorRecentSamples: [{ error, count }],  // top-3 error codes
//     lastFetchedAt: ISO,
//   }, ...]
//
// CSR / ops use this to answer "is AirView still talking to us?"
// without leaving the admin console.

import { Router, type IRouter } from "express";

import {
  INTEGRATION_SOURCES,
  type IntegrationSource,
} from "@workspace/resupply-integrations";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { getIntegrationAdapters } from "../../lib/integrations/registry";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const LOOKBACK_DAYS = 7;

interface AdapterSummary {
  source: IntegrationSource;
  availability: ReturnType<
    ReturnType<typeof getIntegrationAdapters> extends Map<
      IntegrationSource,
      infer A
    >
      ? A extends { availability: () => infer R }
        ? () => R
        : never
      : never
  >;
}

// Vendor-adapter health dashboard. Used by CSRs + ops to answer
// "is AirView still talking to us?" — surveyors-and-ops audience.
// `admin.tools.manage` is the catalog's "supervisor-tier admin
// tooling" perm (admin / supervisor / compliance_officer
// post-Phase-B).
router.get("/admin/integrations/status", requirePermission("admin.tools.manage"), async (_req, res) => {
  const adapters = getIntegrationAdapters();
  const supabase = getSupabaseServiceRoleClient();
  const cutoff = new Date(
    Date.now() - LOOKBACK_DAYS * 86400_000,
  ).toISOString();

  const results: Array<{
    source: IntegrationSource;
    availability: AdapterSummary["availability"];
    recentSnapshots: { ok: number; error: number };
    errorSamples: Array<{ error: string; count: number }>;
    lastFetchedAt: string | null;
  }> = [];

  for (const source of INTEGRATION_SOURCES) {
    const adapter = adapters.get(source);
    if (!adapter) continue;

    // Head-only counts per fetch_status for the last 7 days.
    const okHead = await supabase
      .schema("resupply")
      .from("patient_integration_snapshots")
      .select("*", { count: "exact", head: true })
      .eq("source", source)
      .eq("fetch_status", "ok")
      .gte("fetched_at", cutoff);
    const errHead = await supabase
      .schema("resupply")
      .from("patient_integration_snapshots")
      .select("*", { count: "exact", head: true })
      .eq("source", source)
      .eq("fetch_status", "error")
      .gte("fetched_at", cutoff);

    // Sample the most recent error codes (cap 50 rows; bucket in JS).
    const { data: errSample } = await supabase
      .schema("resupply")
      .from("patient_integration_snapshots")
      .select("fetch_error")
      .eq("source", source)
      .eq("fetch_status", "error")
      .gte("fetched_at", cutoff)
      .order("fetched_at", { ascending: false })
      .limit(50);
    const counts: Record<string, number> = {};
    for (const r of errSample ?? []) {
      const k = r.fetch_error ?? "unknown_error";
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const errorSamples = Object.entries(counts)
      .map(([error, count]) => ({ error, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    const { data: lastRow } = await supabase
      .schema("resupply")
      .from("patient_integration_snapshots")
      .select("fetched_at")
      .eq("source", source)
      .order("fetched_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    results.push({
      source,
      availability: adapter.availability(),
      recentSnapshots: {
        ok: okHead.count ?? 0,
        error: errHead.count ?? 0,
      },
      errorSamples,
      lastFetchedAt: lastRow?.fetched_at ?? null,
    });
  }

  res.json({ adapters: results, lookbackDays: LOOKBACK_DAYS });
});

export default router;

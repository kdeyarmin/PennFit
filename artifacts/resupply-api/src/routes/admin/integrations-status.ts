// /admin/integrations/status — per-vendor adapter availability +
// recent fetch health.
//
// Returns:
//   adapters: [{
//     source,
//     availability: { status: "configured" | "stub" | "unavailable", reason? },
//     connector: { status, lastValidationSuccessAt, lastErrorCategory, … },
//     recentSnapshots: { ok: N, error: N },
//     errorRecentSamples: [{ error, count }],  // top-3 error codes
//     lastFetchedAt: ISO,
//   }, ...]
//
// CSR / ops use this to answer "is AirView still talking to us?"
// without leaving the admin console.
//
// `availability` AND `connector` are BOTH reported, and the pair is the
// point. `availability()` reads environment variables — it answers "are
// the credentials present?", which a revoked secret, a missing
// partnership entitlement, and a wrong endpoint path all pass. Every
// endpoint in the three vendor clients is an unverified placeholder
// written against published docs, so "configured" is close to
// meaningless as a health signal on its own.
//
// `connector` is the recorded outcome of calls that actually happened
// (migration 0542). `status: "live_validated"` is the ONLY value that
// means a real vendor call has succeeded for this tenant, and nothing in
// the product may claim production validation without it. A source with
// no row reports `unvalidated` — which is different from
// `not_configured`, and both are different from "working".

import { Router, type IRouter } from "express";

import {
  INTEGRATION_SOURCES,
  type IntegrationSource,
} from "@workspace/resupply-integrations";
import { getOrgScopedClient } from "@workspace/resupply-db";

import { readConnectorStatuses } from "../../lib/integrations/connector-status";
import {
  getIntegrationAdapters,
  getIntegrationAdaptersForOrg,
} from "../../lib/integrations/registry";
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
router.get(
  "/admin/integrations/status",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    // Fail closed: never widen to all tenants on a missing orgId.
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const adapters = await getIntegrationAdaptersForOrg(orgId);
    const db = getOrgScopedClient(orgId);
    // Fail-soft: a missing status table must not take down the health
    // page that an operator opens BECAUSE something is wrong.
    const connectorStatuses = await readConnectorStatuses(orgId).catch(
      () => new Map(),
    );
    const cutoff = new Date(
      Date.now() - LOOKBACK_DAYS * 86400_000,
    ).toISOString();

    const results: Array<{
      source: IntegrationSource;
      availability: AdapterSummary["availability"];
      connector: {
        status: string;
        lastValidationAttemptAt: string | null;
        lastValidationSuccessAt: string | null;
        lastSyncSuccessAt: string | null;
        lastErrorCategory: string | null;
        lastErrorStep: string | null;
        lastErrorRemedy: string | null;
        vendorApiVersion: string | null;
        partialResources: Array<{ resource: string; error: string }>;
        consecutiveFailures: number;
        lastReconciliationAt: string | null;
        lastReconciliationStatus: string | null;
      };
      recentSnapshots: { ok: number; error: number };
      errorSamples: Array<{ error: string; count: number }>;
      lastFetchedAt: string | null;
    }> = [];

    for (const source of INTEGRATION_SOURCES) {
      const adapter = adapters.get(source);
      if (!adapter) continue;

      // Head-only counts per fetch_status for the last 7 days.
      const okHead = await db
        .from("patient_integration_snapshots")
        .select("*", { count: "exact", head: true })
        .eq("source", source)
        .eq("fetch_status", "ok")
        .gte("fetched_at", cutoff);
      const errHead = await db
        .from("patient_integration_snapshots")
        .select("*", { count: "exact", head: true })
        .eq("source", source)
        .eq("fetch_status", "error")
        .gte("fetched_at", cutoff);

      // Sample the most recent error codes (cap 50 rows; bucket in JS).
      const { data: errSample } = await db
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

      const { data: lastRow } = await db
        .from("patient_integration_snapshots")
        .select("fetched_at")
        .eq("source", source)
        .order("fetched_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const recorded = connectorStatuses.get(source);
      results.push({
        source,
        availability: adapter.availability(),
        // Absent means nobody has ever validated this connector here.
        // `unvalidated` says so; it must never be rendered as healthy.
        connector: recorded
          ? {
              status: recorded.status,
              lastValidationAttemptAt: recorded.lastValidationAttemptAt,
              lastValidationSuccessAt: recorded.lastValidationSuccessAt,
              lastSyncSuccessAt: recorded.lastSyncSuccessAt,
              lastErrorCategory: recorded.lastErrorCategory,
              lastErrorStep: recorded.lastErrorStep,
              lastErrorRemedy: recorded.lastErrorRemedy,
              vendorApiVersion: recorded.vendorApiVersion,
              partialResources: recorded.partialResources,
              consecutiveFailures: recorded.consecutiveFailures,
              lastReconciliationAt: recorded.lastReconciliationAt,
              lastReconciliationStatus: recorded.lastReconciliationStatus,
            }
          : {
              status: "unvalidated",
              lastValidationAttemptAt: null,
              lastValidationSuccessAt: null,
              lastSyncSuccessAt: null,
              lastErrorCategory: null,
              lastErrorStep: null,
              lastErrorRemedy: null,
              vendorApiVersion: null,
              partialResources: [],
              consecutiveFailures: 0,
              lastReconciliationAt: null,
              lastReconciliationStatus: null,
            },
        recentSnapshots: {
          ok: okHead.count ?? 0,
          error: errHead.count ?? 0,
        },
        errorSamples,
        lastFetchedAt: lastRow?.fetched_at ?? null,
      });
    }

    res.json({ adapters: results, lookbackDays: LOOKBACK_DAYS });
  },
);

export default router;

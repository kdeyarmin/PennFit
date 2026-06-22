// Platform super-admin analytics dashboard (G4).
//
//   GET /resupply-api/platform/analytics?days=30
//
// The cross-tenant command-center metrics: fleet headline totals,
// current-vs-prior window deltas, daily trend series (new patients /
// orders / conversations + GMV), and a per-tenant leaderboard. Gated by
// `requirePlatformAdmin`.
//
// PII posture: AGGREGATE COUNTS + DOLLAR ROLLUPS ONLY — exactly like
// /platform/overview. The per-tenant fan-out selects nothing but
// timestamps and order amounts; no patient row, name, or contact ever
// crosses this surface. A super-admin who needs a tenant's real records
// uses audited impersonation.
//
// Fan-out is bounded by tenant count (a handful) and the window. Each
// tenant contributes: 3 HEAD counts (all-time patients/orders/
// conversations) + 3 windowed selects (timestamps, capped). A per-tenant
// failure degrades that tenant's contribution rather than failing the
// whole dashboard.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  aggregatePlatformAnalytics,
  type AnalyticsOrder,
  type AnalyticsTenantInput,
} from "../../lib/platform-analytics";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePlatformAdmin } from "../../middlewares/requirePlatformAdmin";

const router: IRouter = Router();

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional().default(30),
});

// Cap the windowed row fetch so a high-volume tenant can't time the
// dashboard out. The series degrades to "first N rows of the window"
// rather than failing — acceptable for a trend chart.
const WINDOW_ROW_CAP = 50_000;

interface OrgRow {
  id: string;
  slug: string;
  name: string | null;
  status: string;
  created_at: string;
}

/** All-time HEAD count for one table, degrading to null on error. */
async function headCount(
  db: ReturnType<typeof getOrgScopedClient>,
  table: Parameters<ReturnType<typeof getOrgScopedClient>["from"]>[0],
): Promise<number | null> {
  try {
    const { count, error } = await db
      .from(table)
      .select("*", { count: "exact", head: true });
    if (error) throw error;
    return count ?? 0;
  } catch {
    return null;
  }
}

/** Window `created_at` list for one table (no PHI), degrading to []. */
async function windowCreatedAt(
  db: ReturnType<typeof getOrgScopedClient>,
  table: Parameters<ReturnType<typeof getOrgScopedClient>["from"]>[0],
  cutoffIso: string,
): Promise<string[]> {
  try {
    const { data, error } = await db
      .from(table)
      .select("created_at")
      .gte("created_at", cutoffIso)
      // Deterministic cap: keep the most recent rows if the window
      // exceeds WINDOW_ROW_CAP (PostgREST doesn't guarantee order
      // otherwise, which would make the trend sample nondeterministic).
      .order("created_at", { ascending: false })
      .limit(WINDOW_ROW_CAP);
    if (error) throw error;
    return ((data ?? []) as Array<{ created_at: string | null }>)
      .map((r) => r.created_at)
      .filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

/** Window orders for one tenant (timestamps + amounts, no PHI), [] on error. */
async function windowOrders(
  db: ReturnType<typeof getOrgScopedClient>,
  cutoffIso: string,
): Promise<AnalyticsOrder[]> {
  try {
    const { data, error } = await db
      .from("shop_orders")
      .select("created_at, paid_at, amount_total_cents, amount_refunded_cents")
      .gte("created_at", cutoffIso)
      // Deterministic cap (most-recent first) — see windowCreatedAt.
      .order("created_at", { ascending: false })
      .limit(WINDOW_ROW_CAP);
    if (error) throw error;
    return (
      (data ?? []) as Array<{
        created_at: string | null;
        paid_at: string | null;
        amount_total_cents: number | null;
        amount_refunded_cents: number | null;
      }>
    )
      .filter((r) => typeof r.created_at === "string")
      .map((r) => ({
        createdAt: r.created_at as string,
        paidAt: r.paid_at,
        amountCents: r.amount_total_cents ?? 0,
        refundedCents: r.amount_refunded_cents ?? 0,
      }));
  } catch {
    return [];
  }
}

/**
 * Assemble the analytics input for ONE tenant: all-time HEAD counts plus
 * the windowed (2× the window, for prior-period deltas) timestamp/order
 * fetches. Shared by the fleet route and the per-tenant series route so
 * both compute identical numbers from the same source.
 */
async function buildTenantInput(
  org: OrgRow,
  fetchCutoffIso: string,
): Promise<AnalyticsTenantInput> {
  const db = getOrgScopedClient(org.id);
  const [patients, orders, conversations] = await Promise.all([
    headCount(db, "patients"),
    headCount(db, "shop_orders"),
    headCount(db, "conversations"),
  ]);
  const [patientCreatedAt, orderRows, conversationCreatedAt] =
    await Promise.all([
      windowCreatedAt(db, "patients", fetchCutoffIso),
      windowOrders(db, fetchCutoffIso),
      windowCreatedAt(db, "conversations", fetchCutoffIso),
    ]);
  return {
    id: org.id,
    slug: org.slug,
    name: org.name,
    status: org.status,
    createdAt: org.created_at,
    allTime: { patients, orders, conversations },
    patientCreatedAt,
    orders: orderRows,
    conversationCreatedAt,
  };
}

router.get(
  "/platform/analytics",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days;

    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }

    // The global tenant directory via the `.raw()` escape hatch.
    const { data: orgs, error: dirErr } = await getOrgScopedClient(seedOrgId)
      .raw()
      .schema("resupply")
      .from("organizations")
      .select("id, slug, name, status, created_at")
      .order("created_at", { ascending: true });
    if (dirErr) {
      logger.error(
        { event: "platform_analytics_dir_failed", err: dirErr },
        "platform analytics: tenant directory query failed",
      );
      res.status(500).json({ error: "analytics_failed" });
      return;
    }

    const nowMs = Date.now();
    // Fetch 2× the window so the route can compute the prior-period delta
    // from the same rows.
    const fetchCutoffIso = new Date(
      nowMs - 2 * days * 86_400_000,
    ).toISOString();

    const tenants: AnalyticsTenantInput[] = await Promise.all(
      ((orgs ?? []) as OrgRow[]).map((o) =>
        buildTenantInput(o, fetchCutoffIso),
      ),
    );

    const result = aggregatePlatformAnalytics({ nowMs, days, tenants });
    res.json({ ...result, generatedAt: new Date(nowMs).toISOString() });
  },
);

// ── GET /platform/tenants/:id/activity-series ───────────────────────
// One tenant's daily trend series + window totals/deltas — the same
// numbers the fleet dashboard shows, scoped to a single tenant (so the
// tenant-detail page can render sparklines). Reuses the shared aggregator
// with a one-element input, so a single tenant's series === the "fleet"
// series of a fleet of one. AGGREGATE COUNTS + DOLLAR ROLLUPS ONLY — no
// PHI crosses this surface (same posture as /platform/analytics).
const seriesParam = z.object({ id: z.string().uuid() });

router.get(
  "/platform/tenants/:id/activity-series",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    const parsedParam = seriesParam.safeParse(req.params);
    if (!parsedParam.success) {
      res.status(400).json({ error: "invalid_tenant_id" });
      return;
    }
    const parsedQuery = querySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const id = parsedParam.data.id;
    const days = parsedQuery.data.days;

    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }

    const { data: org, error: orgErr } = await getOrgScopedClient(seedOrgId)
      .raw()
      .schema("resupply")
      .from("organizations")
      .select("id, slug, name, status, created_at")
      .eq("id", id)
      .limit(1)
      .maybeSingle();
    if (orgErr) {
      logger.error(
        { event: "platform_tenant_series_org_read_failed", err: orgErr },
        "platform analytics: tenant series org read failed",
      );
      res.status(500).json({ error: "tenant_read_failed" });
      return;
    }
    if (!org) {
      res.status(404).json({ error: "tenant_not_found" });
      return;
    }

    const nowMs = Date.now();
    const fetchCutoffIso = new Date(
      nowMs - 2 * days * 86_400_000,
    ).toISOString();
    const input = await buildTenantInput(org as OrgRow, fetchCutoffIso);
    const result = aggregatePlatformAnalytics({
      nowMs,
      days,
      tenants: [input],
    });

    res.json({
      tenantId: id,
      days,
      dayKeys: result.dayKeys,
      window: result.window,
      series: result.series,
      generatedAt: new Date(nowMs).toISOString(),
    });
  },
);

export default router;

// GET /admin/analytics/order-outcomes — the first surface that joins the
// resupply funnel to the money.
//
// Everything upstream of a claim was measured in one place
// (lib/analytics/aggregate.ts, which stops at `fulfilled`) and everything
// downstream in another (the billing dashboards, which start at a claim
// and know nothing about the episode behind it). Nothing joined them, so
// the question the business asks — of the patients who were due, how many
// ended up as money, and where did the rest go — had no answer.
//
// The join key has existed since migration 0118
// (`insurance_claims.fulfillment_id`) and nothing used it. This walks it:
//
//   episodes --episode_id--> fulfillments --fulfillment_id--> insurance_claims
//
// PostgREST has no JOIN, so that is three passes stitched in JS, chunked
// at 200 uuids for the URL limit AND offset-paged at 1000 INSIDE each
// chunk. The paging is not optional: 200 parents can own more than one
// page of children, and an unpaginated read silently truncates — which
// here would understate every count below it and read as a business
// problem rather than a bug. worker/jobs/reminders.ts carries the same
// discipline with five comments explaining why.
//
// PHI: the response is counts, status strings, reason CODES, and catalog
// descriptions. No patient ids, no names, no claim numbers, and never the
// composed `denial_reason` prose (which can quote member detail).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import {
  aggregateOrderOutcomeFunnel,
  type OutcomeClaimRow,
  type OutcomeEpisodeRow,
  type OutcomeFulfillmentRow,
} from "../../lib/analytics/order-outcome-funnel";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const PAGE_SIZE = 1000;
const READ_CHUNK = 200;

/**
 * Capped at 90 days deliberately. This is computed per request rather
 * than materialized, because a claim keeps moving for months after the
 * ship (draft → submitted → accepted → paid, plus denied → appealed →
 * accepted), and every one of those transitions retroactively changes
 * which bucket a PAST episode belongs to — so a nightly snapshot would be
 * stale the moment a payer responded. A 90-day window on a mid-size DME
 * is roughly 60k rows across the three passes; a year would be four times
 * that and too slow for an HTTP request. If a tenant ever outgrows this,
 * the escalation is an org-scoped RPC doing the join in Postgres (the
 * pattern migration 0387 already established), not a denormalized table.
 */
const querySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(90).optional().default(30),
  })
  .strict();

async function collectAllRows<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return out;
}

router.get(
  "/admin/analytics/order-outcomes",
  adminReadRateLimiter,
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_query",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    // Trim-check, not just falsy: getOrgScopedClient throws on whitespace.
    const orgId = req.orgId;
    if (!orgId || !orgId.trim()) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }

    const days = parsed.data.days;
    const nowIso = new Date().toISOString();
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const supabase = getOrgScopedClient(orgId);

    // 1. The funnel's mouth: episodes that became DUE in the window.
    //    Bounded on `due_at`, not `created_at`, matching how
    //    /admin/reorder-reminders defines "due".
    const episodeRows = await collectAllRows<{
      id: string;
      status: string;
      closed_reason: string | null;
    }>((from, to) =>
      supabase
        .from("episodes")
        .select("id, status, closed_reason")
        .gte("due_at", cutoff)
        .lte("due_at", nowIso)
        .order("id", { ascending: true })
        .range(from, to),
    );

    const episodes: OutcomeEpisodeRow[] = episodeRows.map((r) => ({
      id: r.id,
      status: r.status,
      closedReason: r.closed_reason,
    }));

    // 2. Fulfillments for those episodes.
    const fulfillments: OutcomeFulfillmentRow[] = [];
    const episodeIds = episodes.map((e) => e.id);
    for (let i = 0; i < episodeIds.length; i += READ_CHUNK) {
      const chunk = episodeIds.slice(i, i + READ_CHUNK);
      const rows = await collectAllRows<{
        id: string;
        episode_id: string;
        status: string;
        shipped_at: string | null;
      }>((from, to) =>
        supabase
          .from("fulfillments")
          .select("id, episode_id, status, shipped_at")
          .in("episode_id", chunk)
          .order("id", { ascending: true })
          .range(from, to),
      );
      for (const r of rows) {
        fulfillments.push({
          id: r.id,
          episodeId: r.episode_id,
          status: r.status,
          shippedAt: r.shipped_at,
        });
      }
    }

    // 3. Claims for those fulfillments.
    const claims: OutcomeClaimRow[] = [];
    const fulfillmentIds = fulfillments.map((f) => f.id);
    for (let i = 0; i < fulfillmentIds.length; i += READ_CHUNK) {
      const chunk = fulfillmentIds.slice(i, i + READ_CHUNK);
      const rows = await collectAllRows<{
        fulfillment_id: string;
        status: string;
        denial_reason: string | null;
        total_paid_cents: number | null;
      }>((from, to) =>
        supabase
          .from("insurance_claims")
          .select("id, fulfillment_id, status, denial_reason, total_paid_cents")
          .in("fulfillment_id", chunk)
          .order("id", { ascending: true })
          .range(from, to),
      );
      for (const r of rows) {
        claims.push({
          fulfillmentId: r.fulfillment_id,
          status: r.status,
          denialReason: r.denial_reason,
          totalPaidCents: r.total_paid_cents ?? 0,
        });
      }
    }

    const funnel = aggregateOrderOutcomeFunnel({
      episodes,
      fulfillments,
      claims,
    });

    // 4. Human descriptions for the CARC codes we found.
    //
    //    `resupply.denial_codes` is a GLOBAL reference catalog with no
    //    org_id (explicitly excluded by migrations 0341/0342), so it must
    //    be read through `.raw()`. The org-scoped facade would append
    //    `.eq("org_id", …)` and match nothing, silently leaving every
    //    denial unlabelled.
    const codes = funnel.deniedByCarc
      .map((d) => d.code)
      .filter((c) => c !== "uncoded");
    const descriptionByCode = new Map<string, string>();
    if (codes.length > 0) {
      // raw-org-scope-exempt: denial_codes is a global CARC/RARC reference
      // catalog shared by every tenant; it carries no org_id by design.
      const { data, error } = await supabase
        .raw()
        .schema("resupply")
        .from("denial_codes")
        .select("code, description, recommended_action")
        .eq("code_system", "carc")
        .in("code", codes);
      if (error) throw error;
      for (const row of (data ?? []) as Array<{
        code: string;
        description: string | null;
        recommended_action: string | null;
      }>) {
        descriptionByCode.set(
          row.code,
          row.description ?? row.recommended_action ?? "",
        );
      }
    }

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      days,
      stages: funnel.stages,
      rates: funnel.rates,
      preShipLoss: funnel.preShipLoss,
      postShipLoss: funnel.postShipLoss,
      inFlight: funnel.inFlight,
      unverified: funnel.unverified,
      deniedByCarc: funnel.deniedByCarc.map((d) => ({
        ...d,
        // Empty when the code is not in the catalog (or is `uncoded`) —
        // the count still stands, so the total is never quietly wrong.
        description: descriptionByCode.get(d.code) ?? "",
      })),
    });
  },
);

export default router;

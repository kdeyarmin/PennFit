// GET /episodes/counts — per-status counts for the dispatcher
// strip on the Episodes page (A3).
//
// Implementation strategy:
//   PostgREST has no GROUP BY, so the per-status counts fan out
//   into N parallel `head:true` counts (one per status) plus a
//   separate query for the synthetic `overdue` bucket. The
//   `episodes_status_idx` index makes each call cheap.
//
// The `q` filter mirrors /episodes exactly (same `resolveEpisodesSearch`
// helper). When set we resolve the candidate episode-id set up front
// and constrain every count with `.in("id", qEpisodeIds)`.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";
import { resolveEpisodesSearch } from "./list";

// The full set of episode statuses — kept as a literal union so the
// `result` record below is exhaustively-typed without a runtime
// constant array (the array form trips no-unused-vars; the union
// form documents intent and lets TS catch a missing key).
type Status =
  | "outreach_pending"
  | "awaiting_response"
  | "confirmed"
  | "declined"
  | "expired"
  | "fulfilled"
  | "canceled";

const countsQuery = z
  .object({
    q: z
      .string()
      .max(64)
      .optional()
      .transform((v) => {
        const t = v?.trim() ?? "";
        return t === "" ? undefined : t;
      }),
  })
  .strict();

const router: IRouter = Router();

router.get("/episodes/counts", requireAdmin, async (req, res) => {
  const parsed = countsQuery.safeParse(req.query);
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
  const { q } = parsed.data;

  const supabase = getSupabaseServiceRoleClient();
  const nowIso = new Date().toISOString();

  // Resolve the q-filter into a candidate episode-id set up front.
  // Empty array short-circuits to an all-zeroes response.
  let qEpisodeIds: string[] | null = null;
  if (q) {
    qEpisodeIds = await resolveEpisodesSearch(supabase, q);
    if (qEpisodeIds.length === 0) {
      res.status(200).json({
        overdue: 0,
        outreach_pending: 0,
        awaiting_response: 0,
        confirmed: 0,
        declined: 0,
        expired: 0,
        fulfilled: 0,
        canceled: 0,
        all: 0,
      });
      return;
    }
  }

  // PostgREST has no GROUP BY, so we fan the per-status counts out
  // into N parallel head:true counts. The `episodes_status_idx`
  // index makes each one cheap.
  const STATUSES: readonly Status[] = [
    "outreach_pending",
    "awaiting_response",
    "confirmed",
    "declined",
    "expired",
    "fulfilled",
    "canceled",
  ] as const;

  const countQuery = (status: Status) => {
    let q = supabase
      .schema("resupply")
      .from("episodes")
      .select("*", { count: "exact", head: true })
      .eq("status", status);
    if (qEpisodeIds) q = q.in("id", qEpisodeIds);
    return q;
  };
  const overdueQuery = () => {
    let q = supabase
      .schema("resupply")
      .from("episodes")
      .select("*", { count: "exact", head: true })
      .in("status", ["outreach_pending", "awaiting_response"])
      .lte("due_at", nowIso);
    if (qEpisodeIds) q = q.in("id", qEpisodeIds);
    return q;
  };

  const [perStatus, overdueRes] = await Promise.all([
    Promise.all(STATUSES.map((s) => countQuery(s))),
    overdueQuery(),
  ]);
  for (const r of perStatus) if (r.error) throw r.error;
  if (overdueRes.error) throw overdueRes.error;

  const result: Record<Status | "overdue" | "all", number> = {
    overdue: overdueRes.count ?? 0,
    outreach_pending: 0,
    awaiting_response: 0,
    confirmed: 0,
    declined: 0,
    expired: 0,
    fulfilled: 0,
    canceled: 0,
    all: 0,
  };
  for (let i = 0; i < STATUSES.length; i++) {
    const c = perStatus[i]!.count ?? 0;
    result[STATUSES[i]!] = c;
    result.all += c;
  }

  res.status(200).json(result);
});

export default router;

// GET /episodes — paginated episode queue.
//
// The synthetic `overdue` status is the admin's actionable queue:
// episodes still in outreach (`outreach_pending` or
// `awaiting_response`) whose dueAt is in the past. Sort key for the
// overdue queue is oldest-due-first (the most overdue is most
// urgent). For non-overdue queries the sort key is createdAt DESC.
//
// Joins prescriptions for itemSku + cadenceDays and patients for
// firstName + lastName so the queue table renders without N+1
// lookups. PHI surfaced is the same shape as the patient list —
// name only, never phone or email.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const listQuery = z
  .object({
    status: z
      .enum([
        "overdue",
        "outreach_pending",
        "awaiting_response",
        "confirmed",
        "declined",
        "expired",
        "fulfilled",
        "canceled",
      ])
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
    // Free-text filter (A8). Substring match against patient legal
    // name OR exact match against patient/episode id. The 64-char
    // cap mirrors the longest plausible "first last" string and
    // bounds LIKE pattern complexity. We trim BEFORE validating so
    // an all-whitespace query is treated as "no filter" — the page
    // sends the input box value directly without trimming so the
    // single-source-of-truth lives here.
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

// Resolve the free-text `q` filter into a list of episode IDs that
// match. Used by both the list endpoint and the counts endpoint so
// the chips reflect the same row-set as the table.
//
// PostgREST has no JOIN, so the original SQL's
//   episodes.id = q OR episodes.patient_id = q
//   OR patients.legal_first_name ILIKE %q% OR …
// becomes two queries: (1) patients.id list by name ILIKE,
// (2) episode IDs whose id == q OR patient_id == q OR patient_id IN
// (matched_patient_ids). The result is a deduplicated set of episode
// IDs the caller can use as a `.in('id', ...)` filter.
export async function resolveEpisodesSearch(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  needle: string,
): Promise<string[]> {
  const pattern = `%${needle}%`;
  const isUuid = UUID_RE.test(needle);

  const { data: matchedPatients, error: patientErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .or(`legal_first_name.ilike.${pattern},legal_last_name.ilike.${pattern}`);
  if (patientErr) throw patientErr;
  const patientIds = (matchedPatients ?? []).map((p) => p.id);

  // No matching patients AND no UUID match → empty result. Returning
  // an empty array short-circuits the caller to a `.in('id', [])`
  // (== always false) without firing the second query.
  if (patientIds.length === 0 && !isUuid) return [];

  let resolveQuery = supabase
    .schema("resupply")
    .from("episodes")
    .select("id");
  const orParts: string[] = [];
  if (isUuid) {
    orParts.push(`id.eq.${needle}`);
    orParts.push(`patient_id.eq.${needle}`);
  }
  if (patientIds.length > 0) {
    orParts.push(`patient_id.in.(${patientIds.join(",")})`);
  }
  resolveQuery = resolveQuery.or(orParts.join(","));
  const { data: matchedEpisodes, error: epErr } = await resolveQuery;
  if (epErr) throw epErr;
  return Array.from(new Set((matchedEpisodes ?? []).map((e) => e.id)));
}

const router: IRouter = Router();

router.get("/episodes", requireAdmin, async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
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
  const { status, limit, offset, q } = parsed.data;
  const isOverdue = status === "overdue";

  const supabase = getSupabaseServiceRoleClient();
  const nowIso = new Date().toISOString();

  // Resolve the q-filter into a candidate episode-id set up front.
  // Empty array means "no matches" → short-circuit to an empty
  // response so the COUNT and main query don't fire.
  let qEpisodeIds: string[] | null = null;
  if (q) {
    qEpisodeIds = await resolveEpisodesSearch(supabase, q);
    if (qEpisodeIds.length === 0) {
      res.status(200).json({ items: [], total: 0, limit, offset });
      return;
    }
  }

  const buildBaseQuery = () => {
    let query = supabase
      .schema("resupply")
      .from("episodes")
      .select(
        "id, patient_id, prescription_id, status, due_at, expires_at, created_at",
        { count: "exact" },
      );
    if (isOverdue) {
      query = query
        .in("status", ["outreach_pending", "awaiting_response"])
        .lte("due_at", nowIso);
    } else if (status) {
      query = query.eq("status", status);
    }
    if (qEpisodeIds) query = query.in("id", qEpisodeIds);
    return query;
  };

  let episodesListQuery = buildBaseQuery();
  if (isOverdue) {
    episodesListQuery = episodesListQuery.order("due_at", { ascending: true });
  } else {
    episodesListQuery = episodesListQuery.order("created_at", { ascending: false });
  }
  episodesListQuery = episodesListQuery.range(offset, offset + limit - 1);
  const { data: rows, count, error } = await episodesListQuery;
  if (error) throw error;

  // Bulk-fetch the joined identity rows. The original Drizzle path
  // LEFT JOINed patients + prescriptions; PostgREST has no JOIN, so
  // we collect the IDs from this page's rows and fetch in one extra
  // round-trip per side.
  const patientIds = Array.from(
    new Set(
      (rows ?? [])
        .map((r) => r.patient_id)
        .filter((v): v is string => v !== null),
    ),
  );
  const prescriptionIds = Array.from(
    new Set(
      (rows ?? [])
        .map((r) => r.prescription_id)
        .filter((v): v is string => v !== null),
    ),
  );

  const [patientsRes, prescriptionsRes] = await Promise.all([
    patientIds.length > 0
      ? supabase
          .schema("resupply")
          .from("patients")
          .select("id, legal_first_name, legal_last_name")
          .in("id", patientIds)
      : Promise.resolve({ data: [], error: null } as const),
    prescriptionIds.length > 0
      ? supabase
          .schema("resupply")
          .from("prescriptions")
          .select("id, item_sku, cadence_days")
          .in("id", prescriptionIds)
      : Promise.resolve({ data: [], error: null } as const),
  ]);
  if (patientsRes.error) throw patientsRes.error;
  if (prescriptionsRes.error) throw prescriptionsRes.error;
  const patientsById = new Map(
    (patientsRes.data ?? []).map((p) => [p.id, p] as const),
  );
  const prescriptionsById = new Map(
    (prescriptionsRes.data ?? []).map((p) => [p.id, p] as const),
  );

  const now = Date.now();
  res.status(200).json({
    items: (rows ?? []).map((r) => {
      const pt = patientsById.get(r.patient_id);
      const rx = prescriptionsById.get(r.prescription_id);
      const dueAtMs = new Date(r.due_at).getTime();
      const daysOverdue = Math.max(
        0,
        Math.floor((now - dueAtMs) / 86_400_000),
      );
      return {
        id: r.id,
        patientId: r.patient_id,
        patientFirstName: pt?.legal_first_name ?? "",
        patientLastName: pt?.legal_last_name ?? "",
        prescriptionId: r.prescription_id,
        itemSku: rx?.item_sku ?? "",
        cadenceDays: rx?.cadence_days ?? 0,
        status: r.status,
        dueAt: r.due_at,
        daysOverdue,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
      };
    }),
    total: count ?? 0,
    limit,
    offset,
  });
});

export default router;

// GET /patients — paginated patient list for the admin console.
//
// All PHI columns are stored as plaintext after migration 0025; we
// select them directly. Phone + email values themselves are never
// returned in the list response — they are surfaced as boolean
// `hasPhone` / `hasEmail` markers (CASE WHEN NOT NULL) so the admin
// can see "this patient is reachable on SMS" without the page itself
// rendering the number.
//
// Search semantics:
//   The single `search` box accepts any of:
//     - pacware id (plaintext, indexed): "PAC-001"
//     - patient name fragment: "alice", "smith"
//     - email fragment: "@gmail.com", "alice@"
//     - phone number in any format: "+14155551212", "(415) 555-1212",
//       "4155551212". When the input normalizes to a valid E.164,
//       we do an exact-match against `patients.phone_e164` (now
//       indexed btree). Otherwise we fall through to the ILIKE
//       union below.
//
// We do NOT write an audit row per list-view: list pages are
// page-flipped many times during normal admin workflow and one
// audit row per page-flip drowns the audit log. The /patients/{id}
// detail view does write an audit row (see ./detail.ts).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { normalizeE164 } from "@workspace/resupply-domain";
import {
  getSupabaseServiceRoleClient,
  escapePostgRESTFilterValue,
} from "@workspace/resupply-db";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const listQuery = z
  .object({
    status: z.enum(["active", "paused", "closed"]).optional(),
    search: z.string().min(1).max(64).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const router: IRouter = Router();

router.get(
  "/patients",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
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
    const { status, search, limit, offset } = parsed.data;

    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("patients")
      .select(
        "id, pacware_id, legal_first_name, legal_last_name, status, phone_e164, email, created_at, updated_at",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq("status", status);
    if (search) {
      // Phone-shaped input → exact-match against the indexed
      // `phone_e164` column. We try this BEFORE the ILIKE branch so
      // that a perfectly-formatted phone number lands in the index
      // path. `normalizeE164` returns null for anything that doesn't
      // parse as a real phone; treat that as "this is a name or
      // email or pacware id" and fall through.
      const normalizedPhone = normalizeE164(search);
      if (normalizedPhone) {
        query = query.eq("phone_e164", normalizedPhone);
      } else {
        // PostgREST `.or()` uses `*` wildcards (not `%`) for ILIKE.
        // Escape commas/parentheses/quotes in the search value to
        // prevent breaking the filter expression.
        const escaped = escapePostgRESTFilterValue(search);
        const needle = `*${escaped}*`;
        query = query.or(
          `pacware_id.ilike.${needle},legal_first_name.ilike.${needle},legal_last_name.ilike.${needle},email.ilike.${needle}`,
        );
      }
    }

    const { data: rows, count, error } = await query;
    if (error) throw error;

    // Bulk-fetch the latest-message projection for the rows on this
    // page. Single round-trip; the `.in()` filter is cheap because the
    // projection is patient-scoped (one row per patient).
    const ids = (rows ?? []).map((r) => r.id);
    let latestById = new Map<
      string,
      {
        last_message_at: string;
        last_message_direction: string;
        last_message_preview: string;
      }
    >();
    if (ids.length > 0) {
      const { data: latest, error: latestErr } = await supabase
        .schema("resupply")
        .from("patient_latest_message")
        .select(
          "patient_id, last_message_at, last_message_direction, last_message_preview",
        )
        .in("patient_id", ids);
      if (latestErr) throw latestErr;
      latestById = new Map(
        (latest ?? []).map((l) => [
          l.patient_id,
          {
            last_message_at: l.last_message_at,
            last_message_direction: l.last_message_direction,
            last_message_preview: l.last_message_preview,
          },
        ]),
      );
    }

    res.status(200).json({
      items: (rows ?? []).map((r) => {
        const latest = latestById.get(r.id);
        return {
          id: r.id,
          pacwareId: r.pacware_id,
          firstName: r.legal_first_name ?? "",
          lastName: r.legal_last_name ?? "",
          status: r.status,
          hasPhone: r.phone_e164 != null,
          hasEmail: r.email != null,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          lastMessageAt: latest?.last_message_at ?? null,
          lastMessageDirection: latest?.last_message_direction ?? null,
          lastMessagePreview: latest?.last_message_preview ?? null,
        };
      }),
      total: count ?? 0,
      limit,
      offset,
    });
  },
);

export default router;

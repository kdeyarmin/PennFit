// /admin/fitter-requests/* — the queue a mask fitting now ends in.
//
// Under `fitter.lead_capture_only` the patient no longer files their own
// insurance order; they send a REQUEST and somebody here places the
// order. This is that worklist.
//
// Endpoints (all permission-gated):
//
//   GET   /admin/fitter-requests?status=new
//                            — list + KPI counts, oldest-waiting first
//                              within the open statuses.
//   PATCH /admin/fitter-requests/:id
//                            — move a request through
//                              new → contacted → in_progress → closed,
//                              and/or leave a CSR note.
//
// PHI handling mirrors the insurance-lead queue it sits beside: the rows
// carry name, phone, date of birth and (when the patient supplied them)
// insurance identifiers in the clear, because every admin reaching
// /admin/* has already cleared the PHI-access gate. The log line is
// counts + filter + actor and never the per-row values.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { type Database, getOrgScopedClient } from "@workspace/resupply-db";

import {
  clearFitSessionDispenseById,
  markFitSessionDispensedById,
} from "../../lib/fitting/order-link";
import { redactDbErr } from "../../lib/redact-db-err";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

type FitRequestRow =
  Database["resupply"]["Tables"]["fitter_fit_requests"]["Row"];
type FitRequestUpdate =
  Database["resupply"]["Tables"]["fitter_fit_requests"]["Update"];

const router: IRouter = Router();

const STATUSES = ["new", "contacted", "in_progress", "closed"] as const;
type FitRequestStatus = (typeof STATUSES)[number];

// How a closed request turned out (migration 0519). Only `fulfilled`
// asserts the patient actually has a mask, and only `fulfilled` stamps
// the linked fitting as dispensed — see the note on the stamp below.
const CLOSED_OUTCOMES = [
  "fulfilled",
  "not_proceeding",
  "unreachable",
  "duplicate",
] as const;
type FitRequestClosedOutcome = (typeof CLOSED_OUTCOMES)[number];

const listQuery = z.object({
  status: z
    .enum(["all", ...STATUSES] as ["all", ...typeof STATUSES])
    .optional()
    .default("all"),
  requestType: z
    .enum(["all", "full_details", "callback"])
    .optional()
    .default("all"),
  limit: z
    .string()
    .optional()
    .transform((v) => {
      const n = v ? Number.parseInt(v, 10) : 100;
      if (!Number.isFinite(n)) return 100;
      return Math.max(1, Math.min(200, n));
    }),
});

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const patchBody = z
  .object({
    status: z
      .enum([...STATUSES] as [FitRequestStatus, ...FitRequestStatus[]])
      .optional(),
    // `undefined` MUST survive the transform. The route decides whether
    // to touch the column by `csrNote !== undefined`, so folding an
    // omitted key into `null` here made every status-only PATCH — the
    // most common mutation on this queue — silently delete the CSR's
    // note. Only an EXPLICIT null or empty string means "clear it".
    csrNote: z
      .string()
      .trim()
      .max(2000)
      .nullish()
      .transform((v) =>
        v === undefined ? undefined : v === null || v === "" ? null : v,
      ),
    // Same `undefined`-survives-the-transform discipline as csrNote: an
    // omitted key must not be read as "clear the outcome".
    closedOutcome: z
      .enum([...CLOSED_OUTCOMES] as [
        FitRequestClosedOutcome,
        ...FitRequestClosedOutcome[],
      ])
      .nullish()
      .transform((v) => (v === undefined ? undefined : (v ?? null))),
  })
  .strict()
  .refine(
    (b) =>
      b.status !== undefined ||
      b.csrNote !== undefined ||
      b.closedOutcome !== undefined,
    { message: "must include status, csrNote or closedOutcome" },
  )
  .refine(
    (b) =>
      b.status !== "closed" ||
      (b.closedOutcome !== undefined && b.closedOutcome !== null),
    {
      message: "closing a request requires closedOutcome",
      path: ["closedOutcome"],
    },
  );

function toView(r: FitRequestRow) {
  return {
    id: r.id,
    requestType: r.request_type,
    status: r.status,
    fullName: r.full_name,
    email: r.email,
    phone: r.phone,
    preferredContactMethod: r.preferred_contact_method,
    preferredContactTime: r.preferred_contact_time,
    dateOfBirth: r.date_of_birth,
    insuranceCarrier: r.insurance_carrier,
    memberId: r.member_id,
    groupNumber: r.group_number,
    prescribingPhysician: r.prescribing_physician,
    notes: r.notes,
    population: r.population,
    fitterLeadId: r.fitter_lead_id,
    fitSessionId: r.fit_session_id,
    recommendedMaskId: r.recommended_mask_id,
    recommendedMaskName: r.recommended_mask_name,
    recommendedMaskType: r.recommended_mask_type,
    recommendedMaskSize: r.recommended_mask_size,
    csrNote: r.csr_note,
    contactedAt: r.contacted_at,
    contactedBy: r.contacted_by,
    closedAt: r.closed_at,
    closedOutcome: r.closed_outcome,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Same scope as the insurance-lead queue: both are top-of-funnel
// requests worked by the same CSR cohort.
router.get(
  "/admin/fitter-requests",
  requirePermission("conversations.manage"),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { status, requestType, limit } = parsed.data;
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    let rowsQuery = supabase
      .from("fitter_fit_requests")
      .select("*")
      // OLDEST first, deliberately, and unlike every other admin list in
      // this codebase. This is a promise-shaped queue — the confirmation
      // email tells the patient "within one business day" — so the row
      // that has waited longest is the one that matters, and a
      // newest-first sort buries it the moment volume picks up.
      .order("created_at", { ascending: true })
      .limit(limit);
    if (status !== "all") rowsQuery = rowsQuery.eq("status", status);
    if (requestType !== "all") {
      rowsQuery = rowsQuery.eq("request_type", requestType);
    }

    const { data: rows, error: listErr } = await rowsQuery;
    if (listErr) throw listErr;

    // KPI strip. PostgREST has no GROUP BY, so parallel count-only
    // queries — each index-backed by (org_id, status, created_at).
    const countBase = () =>
      supabase
        .from("fitter_fit_requests")
        .select("*", { count: "exact", head: true });
    const [newCount, contactedCount, inProgressCount, closedCount] =
      await Promise.all([
        countBase().eq("status", "new"),
        countBase().eq("status", "contacted"),
        countBase().eq("status", "in_progress"),
        countBase().eq("status", "closed"),
      ]);
    if (newCount.error) throw newCount.error;
    if (contactedCount.error) throw contactedCount.error;
    if (inProgressCount.error) throw inProgressCount.error;
    if (closedCount.error) throw closedCount.error;

    const counts: Record<FitRequestStatus, number> = {
      new: newCount.count ?? 0,
      contacted: contactedCount.count ?? 0,
      in_progress: inProgressCount.count ?? 0,
      closed: closedCount.count ?? 0,
    };

    req.log?.info?.(
      {
        rowCount: rows?.length ?? 0,
        filter: { status, requestType },
        counts,
      },
      "admin/fitter-requests: list",
    );

    res.json({
      rows: ((rows ?? []) as FitRequestRow[]).map(toView),
      counts,
    });
  },
);

router.patch(
  "/admin/fitter-requests/:id",
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "fitter_requests.update", preset: "mutation" }),
  async (req, res) => {
    const idParam = req.params.id;
    if (typeof idParam !== "string" || !ID_RE.test(idParam)) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const parse = patchBody.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parse.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const nowIso = new Date().toISOString();
    const update: FitRequestUpdate = {};
    /** True when the patch records an outcome without moving the status. */
    let outcomeOnly = false;
    if (parse.data.status !== undefined) {
      update.status = parse.data.status;
      // Stamp the lifecycle timestamps from the transition rather than
      // asking the caller for them, so "who first reached this patient"
      // survives a later status change. `contacted_at` is set once —
      // moving back from closed to contacted must not rewrite history.
      if (
        parse.data.status === "contacted" ||
        parse.data.status === "in_progress"
      ) {
        update.contacted_at = nowIso;
        update.contacted_by = req.adminEmail ?? null;
      }
      if (parse.data.status === "closed") {
        update.closed_at = nowIso;
        // A close may state its outcome in the same call. Absent one, the
        // column stays NULL, which reads honestly as "closed, outcome not
        // recorded" rather than guessing.
        if (parse.data.closedOutcome !== undefined) {
          update.closed_outcome = parse.data.closedOutcome;
        }
      } else {
        update.closed_at = null;
        // Re-opening clears the outcome. A request being worked again has
        // no outcome yet, and leaving a stale 'fulfilled' behind would
        // keep counting a dispense for a fitting back in the queue.
        update.closed_outcome = null;
      }
    } else if (parse.data.closedOutcome !== undefined) {
      // Outcome-only patch: a CSR recording (or correcting) how an
      // already-closed request turned out, without touching its status.
      //
      // Never clear the outcome to null here — a closed request must keep
      // an outcome (the close refine already requires one), and the
      // closed-row dropdown must not wipe fulfilled dispense attribution
      // by selecting the placeholder. Guarded on the row still being
      // closed further down.
      if (parse.data.closedOutcome === null) {
        res.status(400).json({
          error: "invalid_body",
          message:
            "cannot clear closedOutcome on a closed request; pick a real outcome",
        });
        return;
      }
      update.closed_outcome = parse.data.closedOutcome;
      outcomeOnly = true;
    }
    if (parse.data.csrNote !== undefined) update.csr_note = parse.data.csrNote;

    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    // "Who first reached this patient" is claimed ATOMICALLY, in its own
    // conditional update, before the rest of the patch.
    //
    // A read-then-write here looked equivalent and was not: two CSRs
    // opening the same request can both observe `contacted_at` as null
    // and then both write, so the LAST one wins and the record shows the
    // wrong person at the wrong time — which is precisely the fact this
    // column exists to preserve across re-opens. `.is("contacted_at",
    // null)` makes the database the arbiter: whoever gets there first
    // sets it, the loser's update matches no row and changes nothing.
    const firstContact = update.contacted_at;
    const firstContactBy = update.contacted_by;
    delete update.contacted_at;
    delete update.contacted_by;
    if (firstContact) {
      const { error: claimErr } = await supabase
        .from("fitter_fit_requests")
        .update({ contacted_at: firstContact, contacted_by: firstContactBy })
        .eq("id", idParam)
        .is("contacted_at", null);
      // A failed claim costs the row its provenance stamp, not the status
      // change the CSR actually asked for — so it is logged, not thrown.
      if (claimErr) {
        req.log?.warn?.(
          { err: redactDbErr(claimErr), id: idParam },
          "admin/fitter-requests: first-contact claim failed",
        );
      }
    }

    let query = supabase
      .from("fitter_fit_requests")
      .update(update)
      .eq("id", idParam);
    if (outcomeOnly) query = query.eq("status", "closed");

    const { data: row, error } = await query
      .select(
        "id, status, csr_note, contacted_at, contacted_by, closed_at, closed_outcome, fit_session_id, recommended_mask_id, updated_at",
      )
      .maybeSingle();

    if (error) {
      // 23505 = unique_violation, and the only unique constraint this
      // update can trip is the open-request dedupe index (migration
      // 0519). It means re-opening this request would put a SECOND open
      // copy of the same ask in the queue, because the patient already
      // filed an identical one after this was closed. Tell the CSR that
      // rather than handing them a 500 — the other request is the live
      // one, and this row should stay closed.
      if ((error as { code?: string }).code === "23505") {
        res.status(409).json({
          error: "duplicate_open_request",
          message:
            "This patient already has an identical request open. Work that one instead of re-opening this.",
        });
        return;
      }
      throw error;
    }
    if (!row) {
      // An outcome-only patch that matched nothing means the row is no
      // longer closed — someone re-opened it while this queue view was
      // stale. Distinguishable from a genuinely missing request.
      if (outcomeOnly) {
        res.status(409).json({
          error: "request_not_closed",
          message:
            "This request was re-opened. Close it again to record how it turned out.",
        });
        return;
      }
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Close the fitting → dispense loop.
    //
    // Until migration 0518 the only way a fitting could be recorded as
    // dispensed was the patient buying the mask themselves at checkout.
    // That path is gone, and with it the sole writer of
    // `fit_sessions.dispensed_at` / `ordered_mask_model_id` — which the
    // outcomes dashboard's dispense rate, its accepted-vs-overridden
    // split, and the re-fit campaign's discontinued-mask branch all read.
    // A CSR marking a request `fulfilled` is the same assertion the
    // carrier webhook used to make: this patient HAS their mask.
    //
    // Deliberately after the update and deliberately swallowed: the
    // attribution is a reporting nicety and the close is the CSR's actual
    // work. The stamp is guarded on `dispensed_at IS NULL` at the
    // database, so re-closing a request never moves a date already set.
    let dispenseStamped = false;
    let dispenseCleared = false;
    const fulfilled =
      row.status === "closed" && row.closed_outcome === "fulfilled";
    if (row.fit_session_id) {
      if (fulfilled) {
        const stamp = await markFitSessionDispensedById(orgId, {
          fitSessionId: row.fit_session_id,
          orderedMaskSlug: row.recommended_mask_id,
        }).catch(() => ({ stamped: false }));
        dispenseStamped = stamp.stamped;
      } else if (
        parse.data.closedOutcome !== undefined ||
        parse.data.status !== undefined
      ) {
        // The row is NOT fulfilled and this patch touched what decides
        // that — a corrected outcome, or a re-open. If an earlier
        // `fulfilled` had already stamped the fitting, that stamp is now
        // a claim nobody stands behind, so it is withdrawn. Guarded at
        // the data layer on the fitting having no shop order, so a
        // carrier-confirmed delivery is never erased from here.
        const cleared = await clearFitSessionDispenseById(
          orgId,
          row.fit_session_id,
        ).catch(() => ({ cleared: false }));
        dispenseCleared = cleared.cleared;
      }
    }

    req.log?.info?.(
      {
        id: row.id,
        status: row.status,
        closedOutcome: row.closed_outcome,
        dispenseStamped,
        dispenseCleared,
        actor: req.adminEmail ?? null,
      },
      "admin/fitter-requests: updated",
    );

    res.json({
      id: row.id,
      status: row.status,
      csrNote: row.csr_note,
      contactedAt: row.contacted_at,
      contactedBy: row.contacted_by,
      closedAt: row.closed_at,
      closedOutcome: row.closed_outcome,
      updatedAt: row.updated_at,
      dispenseStamped,
      dispenseCleared,
    });
  },
);

export default router;

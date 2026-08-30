// /admin/fitter-followup-alerts/* — the worklist of everyone whose mask
// fitting went quiet.
//
// Fed by the hourly `fitter-followup.scan` worker (migration 0536),
// which raises one alert per subject for four conditions:
//
//   fit_not_started  — we sent a link and they never opened it.
//   fit_abandoned    — they opened it, started, and stopped partway.
//   fit_no_request   — they FINISHED a fitting and never asked us to
//                      order. The expensive one: the clinical work is
//                      already done.
//   request_unworked — they did ask, and the queue row has sat past the
//                      "within one business day" promise the results
//                      page makes them. Ours, not theirs.
//
// Endpoints (all permission-gated):
//   GET   /admin/fitter-followup-alerts   — list + per-type counts.
//   PATCH /admin/fitter-followup-alerts/:id
//                                         — dismiss, reopen, leave a note.
//
// WHY THE CONTACT IS JOINED RATHER THAN STORED
// --------------------------------------------
// `fitter_followup_alerts` holds foreign keys and a counts-only
// `detail` — no name, email, phone, measurement or clinical finding.
// That keeps a patient's contact details in the one table that already
// owns them (rather than copying them into a second one that grows
// forever and has to be swept), and keeps the alert table safe to count
// and log. The cost is this route: two batched reads to hydrate a page.
// PHI is shown in the clear here because requireAdmin has already
// cleared the PHI-access gate — same posture as the fit-request queue
// this sits beside. The log line is counts + filter + actor, never a
// per-row value.
//
// There is deliberately NO "send another nudge" button. The sweep owns
// the message cadence and its per-invite stamps are what stop a patient
// being messaged twice; a manual re-send here would bypass both. Staff
// who want to reach this person have their phone number and the Fitter
// Invites page's own resend.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { type Database, getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { redactDbErr } from "../../lib/redact-db-err";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

type AlertRow = Database["resupply"]["Tables"]["fitter_followup_alerts"]["Row"];
type AlertUpdate =
  Database["resupply"]["Tables"]["fitter_followup_alerts"]["Update"];

const router: IRouter = Router();

const ALERT_TYPES = [
  "fit_not_started",
  "fit_abandoned",
  "fit_no_request",
  "request_unworked",
] as const;
type AlertType = (typeof ALERT_TYPES)[number];

const STATUSES = ["open", "resolved", "dismissed"] as const;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const listQuery = z.object({
  status: z
    .enum(["all", ...STATUSES] as ["all", ...typeof STATUSES])
    .optional()
    .default("open"),
  type: z
    .enum(["all", ...ALERT_TYPES] as ["all", ...typeof ALERT_TYPES])
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

const ALERT_SELECT =
  "id, alert_type, severity, status, fitter_invite_id, fit_request_id, " +
  "fit_session_id, patient_id, detail, nudge_count, last_nudge_at, " +
  "last_nudge_channel, resolved_at, resolved_reason, dismissed_at, " +
  "dismissed_by_email, staff_note, created_at, updated_at";

/**
 * Severity as a SORT key.
 *
 * `severity` is stored as text, so ordering by the column is
 * alphabetical ('high' < 'low' < 'medium') and silently wrong. Sorting
 * happens here rather than in Postgres for that reason; the DB index
 * serves the status filter.
 */
const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

interface InviteContext {
  status: string;
  channel: string;
  recipientName: string | null;
  recipientEmail: string | null;
  recipientPhoneE164: string | null;
  recommendedMaskName: string | null;
  sentAt: string | null;
  completedAt: string | null;
  expiresAt: string;
}

interface RequestContext {
  status: string;
  requestType: string;
  fullName: string;
  email: string;
  phone: string | null;
  preferredContactMethod: string;
  preferredContactTime: string | null;
  createdAt: string;
}

router.get(
  "/admin/fitter-followup-alerts",
  requirePermission("patients.read"),
  adminRateLimit({ name: "fitter_followup_alerts.list", preset: "query" }),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { status, type, limit } = parsed.data;
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    let query = supabase
      .from("fitter_followup_alerts")
      .select(ALERT_SELECT)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (status !== "all") query = query.eq("status", status);
    if (type !== "all") query = query.eq("alert_type", type);

    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []) as unknown as AlertRow[];

    const [invites, requests] = await Promise.all([
      hydrateInvites(
        supabase,
        rows
          .map((r) => r.fitter_invite_id)
          .filter((v): v is string => typeof v === "string"),
      ),
      hydrateRequests(
        supabase,
        rows
          .map((r) => r.fit_request_id)
          .filter((v): v is string => typeof v === "string"),
      ),
    ]);

    // Open counts per type, so the page can show a tab badge without a
    // second round-trip. Deliberately always the OPEN counts, whatever
    // the caller filtered by — a badge that changed meaning with the
    // filter would be unreadable.
    const { data: openRows, error: countErr } = await supabase
      .from("fitter_followup_alerts")
      .select("alert_type, severity")
      .eq("status", "open")
      .limit(2000);
    if (countErr) throw countErr;

    const counts: Record<AlertType, number> = {
      fit_not_started: 0,
      fit_abandoned: 0,
      fit_no_request: 0,
      request_unworked: 0,
    };
    let openHigh = 0;
    for (const r of (openRows ?? []) as Array<{
      alert_type: AlertType;
      severity: string;
    }>) {
      if (r.alert_type in counts) counts[r.alert_type] += 1;
      if (r.severity === "high") openHigh += 1;
    }
    const openTotal = Object.values(counts).reduce((a, b) => a + b, 0);

    const alerts = rows
      .map((row) => toView(row, invites, requests))
      .sort((a, b) => {
        const bySeverity =
          (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
        if (bySeverity !== 0) return bySeverity;
        // Oldest first inside a severity band: the person who has been
        // waiting longest is the one to call.
        return a.createdAt.localeCompare(b.createdAt);
      });

    logger.info(
      {
        event: "fitter_followup_alerts.list",
        actor: req.adminEmail ?? null,
        status,
        type,
        returned: alerts.length,
        openTotal,
      },
      "fitter follow-up alerts listed",
    );

    res.json({ alerts, counts, openTotal, openHigh });
  },
);

const patchBody = z
  .object({
    // 'dismissed' is a person saying "this needs nothing"; 'open'
    // reopens one that was dismissed by mistake. `resolved` is NOT
    // settable — it means the sweep observed the patient actually act,
    // and letting a human assert it by hand would corrupt the only
    // measure of whether these follow-ups work.
    status: z.enum(["open", "dismissed"]).optional(),
    // `undefined` must survive: the route decides whether to touch the
    // column by `staffNote !== undefined`, so folding an omitted key
    // into null would wipe the note on every status-only PATCH.
    staffNote: z
      .string()
      .trim()
      .max(2000)
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
  })
  .strict()
  .refine((b) => b.status !== undefined || b.staffNote !== undefined, {
    message: "Nothing to update",
  });

router.patch(
  "/admin/fitter-followup-alerts/:id",
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "fitter_followup_alerts.patch", preset: "mutation" }),
  async (req, res) => {
    const id = String(req.params.id ?? "");
    if (!ID_RE.test(id)) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const parsed = patchBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const body = parsed.data;

    const patch: AlertUpdate = {};
    if (body.status === "dismissed") {
      patch.status = "dismissed";
      patch.dismissed_at = new Date().toISOString();
      patch.dismissed_by_email = req.adminEmail ?? null;
    } else if (body.status === "open") {
      patch.status = "open";
      patch.dismissed_at = null;
      patch.dismissed_by_email = null;
      // A reopened alert is open, not resolved. Clearing the resolution
      // too keeps `status` and the two timestamp pairs from disagreeing.
      patch.resolved_at = null;
      patch.resolved_reason = null;
    }
    if (body.staffNote !== undefined) patch.staff_note = body.staffNote;

    const { data, error } = await supabase
      .from("fitter_followup_alerts")
      .update(patch)
      .eq("id", id)
      .select(ALERT_SELECT)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const row = data as unknown as AlertRow;

    const [invites, requests] = await Promise.all([
      hydrateInvites(
        supabase,
        row.fitter_invite_id ? [row.fitter_invite_id] : [],
      ),
      hydrateRequests(supabase, row.fit_request_id ? [row.fit_request_id] : []),
    ]);

    logger.info(
      {
        event: "fitter_followup_alerts.patch",
        actor: req.adminEmail ?? null,
        alertId: id,
        status: patch.status ?? null,
        noteChanged: body.staffNote !== undefined,
      },
      "fitter follow-up alert updated",
    );

    res.json({ alert: toView(row, invites, requests) });
  },
);

async function hydrateInvites(
  supabase: ReturnType<typeof getOrgScopedClient>,
  ids: string[],
): Promise<Map<string, InviteContext>> {
  const out = new Map<string, InviteContext>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;
  try {
    const { data, error } = await supabase
      .from("fitter_invites")
      .select(
        "id, status, channel, recipient_name, recipient_email, " +
          "recipient_phone_e164, recommended_mask_name, sent_at, " +
          "completed_at, expires_at",
      )
      .in("id", unique);
    if (error) throw error;
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      out.set(String(r.id), {
        status: String(r.status ?? ""),
        channel: String(r.channel ?? ""),
        recipientName: (r.recipient_name as string | null) ?? null,
        recipientEmail: (r.recipient_email as string | null) ?? null,
        recipientPhoneE164: (r.recipient_phone_e164 as string | null) ?? null,
        recommendedMaskName: (r.recommended_mask_name as string | null) ?? null,
        sentAt: (r.sent_at as string | null) ?? null,
        completedAt: (r.completed_at as string | null) ?? null,
        expiresAt: String(r.expires_at ?? ""),
      });
    }
  } catch (err) {
    // Degrade to an un-hydrated row rather than 500-ing the page: an
    // alert without its contact still tells a CSR that somebody went
    // quiet, and the deep link still works.
    logger.warn(
      { err: redactDbErr(err) },
      "fitter-followup-alerts: invite hydrate failed",
    );
  }
  return out;
}

async function hydrateRequests(
  supabase: ReturnType<typeof getOrgScopedClient>,
  ids: string[],
): Promise<Map<string, RequestContext>> {
  const out = new Map<string, RequestContext>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;
  try {
    const { data, error } = await supabase
      .from("fitter_fit_requests")
      .select(
        "id, status, request_type, full_name, email, phone, " +
          "preferred_contact_method, preferred_contact_time, created_at",
      )
      .in("id", unique);
    if (error) throw error;
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      out.set(String(r.id), {
        status: String(r.status ?? ""),
        requestType: String(r.request_type ?? ""),
        fullName: String(r.full_name ?? ""),
        email: String(r.email ?? ""),
        phone: (r.phone as string | null) ?? null,
        preferredContactMethod: String(r.preferred_contact_method ?? "phone"),
        preferredContactTime:
          (r.preferred_contact_time as string | null) ?? null,
        createdAt: String(r.created_at ?? ""),
      });
    }
  } catch (err) {
    logger.warn(
      { err: redactDbErr(err) },
      "fitter-followup-alerts: request hydrate failed",
    );
  }
  return out;
}

function toView(
  row: AlertRow,
  invites: Map<string, InviteContext>,
  requests: Map<string, RequestContext>,
) {
  const invite = row.fitter_invite_id
    ? (invites.get(row.fitter_invite_id) ?? null)
    : null;
  const request = row.fit_request_id
    ? (requests.get(row.fit_request_id) ?? null)
    : null;

  // One contact block whichever side the alert came from, so the page
  // renders a single row shape instead of branching per alert type.
  const contact = invite
    ? {
        name: invite.recipientName,
        email: invite.recipientEmail,
        phone: invite.recipientPhoneE164,
        preferredMethod: invite.channel === "sms" ? "text" : "email",
        preferredTime: null as string | null,
      }
    : request
      ? {
          name: request.fullName,
          email: request.email,
          phone: request.phone,
          preferredMethod: request.preferredContactMethod,
          preferredTime: request.preferredContactTime,
        }
      : null;

  return {
    id: row.id,
    alertType: row.alert_type,
    severity: row.severity,
    status: row.status,
    fitterInviteId: row.fitter_invite_id,
    fitRequestId: row.fit_request_id,
    fitSessionId: row.fit_session_id,
    patientId: row.patient_id,
    detail: (row.detail ?? {}) as Record<string, unknown>,
    nudgeCount: row.nudge_count ?? 0,
    lastNudgeAt: row.last_nudge_at,
    lastNudgeChannel: row.last_nudge_channel,
    resolvedAt: row.resolved_at,
    resolvedReason: row.resolved_reason,
    dismissedAt: row.dismissed_at,
    dismissedByEmail: row.dismissed_by_email,
    staffNote: row.staff_note,
    createdAt: row.created_at,
    contact,
    inviteStatus: invite?.status ?? null,
    inviteChannel: invite?.channel ?? null,
    inviteExpiresAt: invite?.expiresAt ?? null,
    recommendedMaskName: invite?.recommendedMaskName ?? null,
    fittingCompletedAt: invite?.completedAt ?? null,
    linkSentAt: invite?.sentAt ?? null,
    requestStatus: request?.status ?? null,
    requestType: request?.requestType ?? null,
    requestCreatedAt: request?.createdAt ?? null,
  };
}

export type FitterFollowupAlertView = ReturnType<typeof toView>;

export default router;

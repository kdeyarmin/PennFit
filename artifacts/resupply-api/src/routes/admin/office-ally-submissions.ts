// /admin/office-ally-submissions — tracking + simple-recovery surface
// for 837P claim files we've uploaded to Office Ally.
//
//   GET   /admin/office-ally-submissions               — list newest-first
//   GET   /admin/office-ally-submissions/:id           — detail incl. linked claims
//   GET   /admin/office-ally-submissions/:id/raw-837p  — download the EDI we
//                                                        sent (regenerated)
//   POST  /admin/office-ally-submissions/:id/resubmit  — re-attempt a
//                                                        transport_failed batch
//   PATCH /admin/office-ally-submissions/:id           — ack-file ingest + status edit
//
// The original UPLOAD happens at
// /admin/billing/batch-submit-office-ally (and the per-claim variant
// on the patients router). This route is the read + ack triage +
// resubmit surface.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import {
  buildEdiPayloadForSubmission,
  executeOfficeAllyBatchSubmit,
} from "../../lib/billing/office-ally-batch";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import {
  requireAdminOnly,
  requirePermission,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

const bulkResubmitBody = z
  .object({
    // Cap at 20 — each entry does a sequential SFTP upload at ~2-5s
    // each, so 20 is roughly a 1-2 min worst-case round-trip. Larger
    // bulks should be split.
    submissionIds: z.array(z.string().uuid()).min(1).max(20),
  })
  .strict();

type SubmissionRowFull = Database["resupply"]["Tables"]["office_ally_submissions"]["Row"];
type SubmissionStatus = SubmissionRowFull["status"];

const STATUS_VALUES = [
  "queued",
  "uploaded",
  "accepted_999",
  "rejected_999",
  "accepted_277ca",
  "rejected_277ca",
  "transport_failed",
] as const satisfies readonly SubmissionStatus[];

const patchBody = z
  .object({
    status: z.enum(STATUS_VALUES).optional(),
    ack999FileName: z.string().trim().max(120).nullable().optional(),
    ack999ReceivedAt: z.string().datetime().nullable().optional(),
    ack277caFileName: z.string().trim().max(120).nullable().optional(),
    ack277caReceivedAt: z.string().datetime().nullable().optional(),
    rejectionReason: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

interface SubmissionRow {
  id: string;
  file_name: string;
  isa_control_number: string;
  gs_control_number: string;
  status: string;
  file_size_bytes: number;
  claim_count: number;
  office_ally_session_id: string | null;
  ack_999_file_name: string | null;
  ack_999_received_at: string | null;
  ack_277ca_file_name: string | null;
  ack_277ca_received_at: string | null;
  rejection_reason: string | null;
  submitted_by_email: string;
  submitted_at: string;
  updated_at: string;
  attempted_claim_ids: string[] | null;
  parent_submission_id: string | null;
}

function rowToApi(r: SubmissionRow) {
  return {
    id: r.id,
    fileName: r.file_name,
    isaControlNumber: r.isa_control_number,
    gsControlNumber: r.gs_control_number,
    status: r.status,
    fileSizeBytes: r.file_size_bytes,
    claimCount: r.claim_count,
    officeAllySessionId: r.office_ally_session_id,
    ack999FileName: r.ack_999_file_name,
    ack999ReceivedAt: r.ack_999_received_at,
    ack277caFileName: r.ack_277ca_file_name,
    ack277caReceivedAt: r.ack_277ca_received_at,
    rejectionReason: r.rejection_reason,
    submittedByEmail: r.submitted_by_email,
    submittedAt: r.submitted_at,
    updatedAt: r.updated_at,
    attemptedClaimIds: r.attempted_claim_ids ?? [],
    parentSubmissionId: r.parent_submission_id,
  };
}

const FULL_SELECT =
  "id, file_name, isa_control_number, gs_control_number, status, file_size_bytes, claim_count, office_ally_session_id, ack_999_file_name, ack_999_received_at, ack_277ca_file_name, ack_277ca_received_at, rejection_reason, submitted_by_email, submitted_at, updated_at, attempted_claim_ids, parent_submission_id";

// ── LIST ────────────────────────────────────────────────────────────
router.get(
  "/admin/office-ally-submissions",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("office_ally_submissions")
      .select(FULL_SELECT)
      .order("submitted_at", { ascending: false })
      .limit(200);
    const statusFilter =
      typeof req.query.status === "string" ? req.query.status : undefined;
    if (statusFilter && isSubmissionStatus(statusFilter)) {
      query = query.eq("status", statusFilter);
    }
    // Free-text search across the two identifiers an op typically has
    // in hand: the ISA control number (from an OA support ticket) and
    // the file name (from a CSR's screenshot). Stripped to digits+letters
    // so we don't pass wildcard control chars into the ilike pattern.
    const qRaw = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (qRaw.length > 0 && qRaw.length <= 80) {
      const safe = qRaw.replace(/[%_]/g, (m) => `\\${m}`);
      query = query.or(
        `isa_control_number.ilike.%${safe}%,file_name.ilike.%${safe}%`,
      );
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ submissions: (data ?? []).map(rowToApi) });
  },
);

// ── BULK RESUBMIT ───────────────────────────────────────────────────
//
// Best-effort "resubmit all of these" for an op cleaning up after a
// transport outage. Takes 1–20 submission ids; for each it does
// exactly what `/admin/office-ally-submissions/:id/resubmit` does
// (delegates to the shared batch core, links parent_submission_id),
// and returns a per-id outcome array so the UI can render a
// success/failure tally.
//
// Sequential, not parallel: each SFTP upload owns the inbox lock
// on Office Ally's side for ~2-5s; parallel uploads risk file-
// name collisions and stress the (single-tenant) SSH session.
//
// Idempotency: each individual resubmit is gated on the original
// row being `transport_failed`; once it succeeds the original row
// stays as-is and a NEW office_ally_submissions row is created with
// parent_submission_id pointing at the original. A second call to
// bulk-resubmit with the same id list will resubmit each ONCE more
// (creating a chain), so the UI guards against double-clicks.
router.post(
  "/admin/office-ally/bulk-resubmit",
  requirePermission("admin.tools.manage"),
  adminRateLimit({
    name: "office_ally.bulk_resubmit",
    preset: "bulk",
  }),
  async (req, res) => {
    const parsed = bulkResubmitBody.safeParse(req.body);
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
    const supabase = getSupabaseServiceRoleClient();
    const { data: originals } = await supabase
      .schema("resupply")
      .from("office_ally_submissions")
      .select("id, status, attempted_claim_ids")
      .in("id", parsed.data.submissionIds);
    const originalsById = new Map<
      string,
      { id: string; status: string; attempted_claim_ids: string[] | null }
    >();
    for (const r of originals ?? []) originalsById.set(r.id, r);

    type OutcomeOk = {
      submissionId: string;
      ok: true;
      newSubmissionId: string;
      claimCount: number;
      isaControlNumber: string;
      transport: string;
      uploadOk: boolean;
      uploadError: string | null;
    };
    type OutcomeErr = {
      submissionId: string;
      ok: false;
      error: string;
      message?: string;
    };
    const outcomes: Array<OutcomeOk | OutcomeErr> = [];

    for (const id of parsed.data.submissionIds) {
      const original = originalsById.get(id);
      if (!original) {
        outcomes.push({ submissionId: id, ok: false, error: "not_found" });
        continue;
      }
      if (original.status !== "transport_failed") {
        outcomes.push({
          submissionId: id,
          ok: false,
          error: "not_resubmittable",
          message: `status is "${original.status}"`,
        });
        continue;
      }
      const claimIds = original.attempted_claim_ids ?? [];
      if (claimIds.length === 0) {
        outcomes.push({
          submissionId: id,
          ok: false,
          error: "no_attempted_claims",
        });
        continue;
      }
      const result = await executeOfficeAllyBatchSubmit({
        claimIds,
        parentSubmissionId: original.id,
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      });
      if (!result.ok) {
        outcomes.push({
          submissionId: id,
          ok: false,
          error: result.kind,
          message:
            typeof result.detail.message === "string"
              ? result.detail.message
              : undefined,
        });
        continue;
      }
      outcomes.push({
        submissionId: id,
        ok: true,
        newSubmissionId: result.submissionId,
        claimCount: result.claimCount,
        isaControlNumber: result.isaControlNumber,
        transport: result.transport,
        uploadOk: result.uploadOk,
        uploadError: result.uploadError,
      });
    }

    const okCount = outcomes.filter((o) => o.ok).length;
    res.json({
      total: outcomes.length,
      okCount,
      failedCount: outcomes.length - okCount,
      outcomes,
    });
  },
);

// ── OPERATIONS SUMMARY (KPI tiles) ─────────────────────────────────
//
// Aggregated counts + rates over the trailing 30 days of OA
// submissions. Powers the KPI row at the top of the OA Operations
// page so a billing director can answer "are we shipping clean
// claims this week?" in one glance.
//
// Definitions (all over the trailing 30-day window):
//   * totalSubmissions     — every office_ally_submissions row
//   * acceptedCount        — accepted_999 + accepted_277ca
//   * rejectedCount        — rejected_999 + rejected_277ca
//   * transportFailedCount — status='transport_failed'
//   * pendingAckCount      — status='uploaded' AND submitted_at > 1h ago
//                            (OA typically returns 999 within 30 min;
//                            > 1h without an ack is a triage signal)
//   * acceptanceRatePct    — accepted / (accepted+rejected); null when
//                            the denominator is 0 so the UI doesn't
//                            render a misleading 100%
//   * avgMinutesToAck999   — mean of ack_999_received_at - submitted_at
//                            on rows where both are set
router.get(
  "/admin/office-ally/operations-summary",
  requirePermission("admin.tools.manage"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .schema("resupply")
      .from("office_ally_submissions")
      .select(
        "status, submitted_at, ack_999_received_at, claim_count",
      )
      .gte("submitted_at", since)
      .limit(5000);
    if (error) throw error;
    const rows = data ?? [];

    let accepted = 0;
    let rejected = 0;
    let transportFailed = 0;
    let pendingAck = 0;
    let totalClaims = 0;
    let ackLatencySumMs = 0;
    let ackLatencyCount = 0;
    for (const r of rows) {
      totalClaims += r.claim_count;
      if (r.status === "accepted_999" || r.status === "accepted_277ca") {
        accepted += 1;
      } else if (
        r.status === "rejected_999" ||
        r.status === "rejected_277ca"
      ) {
        rejected += 1;
      } else if (r.status === "transport_failed") {
        transportFailed += 1;
      } else if (
        r.status === "uploaded" &&
        r.submitted_at < oneHourAgo
      ) {
        pendingAck += 1;
      }
      if (r.ack_999_received_at && r.submitted_at) {
        const ms =
          new Date(r.ack_999_received_at).getTime() -
          new Date(r.submitted_at).getTime();
        if (ms >= 0 && ms < 7 * 24 * 60 * 60 * 1000) {
          ackLatencySumMs += ms;
          ackLatencyCount += 1;
        }
      }
    }
    const decided = accepted + rejected;
    res.json({
      window: { sinceIso: since, days: 30 },
      counts: {
        totalSubmissions: rows.length,
        totalClaims,
        accepted,
        rejected,
        transportFailed,
        pendingAck,
      },
      rates: {
        acceptanceRatePct:
          decided > 0 ? Math.round((accepted / decided) * 1000) / 10 : null,
        avgMinutesToAck999:
          ackLatencyCount > 0
            ? Math.round(ackLatencySumMs / ackLatencyCount / 60000)
            : null,
      },
    });
  },
);

// ── PAYER STATS (top payers by submission volume) ──────────────────
//
// Aggregates the trailing 30 days of office_ally_submissions by
// payer (via the first claim in each batch — batches are single-
// payer by precondition) and returns the top 10. Powers the "By
// payer" card on the OA Operations page so a billing director can
// see at a glance which payers are bleeding rejections vs. which
// are clean.
//
// Per-payer fields returned:
//   * submissionCount     — total OA batches sent in 30d
//   * claimCount          — total individual claims (sum of
//                           claim_count across submissions)
//   * acceptedCount       — accepted_999 + accepted_277ca
//   * rejectedCount       — rejected_999 + rejected_277ca
//   * transportFailedCount
//   * pendingCount        — uploaded / queued (no terminal ack yet)
//   * acceptanceRatePct   — accepted / (accepted+rejected); null on 0 denom
router.get(
  "/admin/office-ally/payer-stats",
  requirePermission("admin.tools.manage"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // 1. Pull recent submissions with their attempted_claim_ids.
    const { data: submissions, error } = await supabase
      .schema("resupply")
      .from("office_ally_submissions")
      .select("id, status, claim_count, attempted_claim_ids")
      .gte("submitted_at", since)
      .limit(5000);
    if (error) throw error;
    const rows = submissions ?? [];
    if (rows.length === 0) {
      res.json({ window: { sinceIso: since, days: 30 }, payers: [] });
      return;
    }

    // 2. Single .in() lookup against the first claim of each batch —
    //    batches are single-payer by precondition, so the first
    //    claim's payer is the batch's payer.
    const firstClaimIds = Array.from(
      new Set(
        rows
          .map((r) => r.attempted_claim_ids?.[0])
          .filter((id): id is string => typeof id === "string"),
      ),
    );
    const claimToPayer = new Map<string, string>();
    if (firstClaimIds.length > 0) {
      const { data: claims } = await supabase
        .schema("resupply")
        .from("insurance_claims")
        .select("id, payer_profile_id")
        .in("id", firstClaimIds);
      for (const c of claims ?? []) {
        if (c.payer_profile_id) {
          claimToPayer.set(c.id, c.payer_profile_id);
        }
      }
    }

    // 3. Aggregate by payer.
    interface Bucket {
      submissionCount: number;
      claimCount: number;
      accepted: number;
      rejected: number;
      transportFailed: number;
      pending: number;
    }
    const byPayer = new Map<string, Bucket>();
    for (const r of rows) {
      const firstClaimId = r.attempted_claim_ids?.[0];
      const payerId = firstClaimId
        ? claimToPayer.get(firstClaimId)
        : undefined;
      if (!payerId) continue;
      let b = byPayer.get(payerId);
      if (!b) {
        b = {
          submissionCount: 0,
          claimCount: 0,
          accepted: 0,
          rejected: 0,
          transportFailed: 0,
          pending: 0,
        };
        byPayer.set(payerId, b);
      }
      b.submissionCount += 1;
      b.claimCount += r.claim_count;
      if (r.status === "accepted_999" || r.status === "accepted_277ca") {
        b.accepted += 1;
      } else if (
        r.status === "rejected_999" ||
        r.status === "rejected_277ca"
      ) {
        b.rejected += 1;
      } else if (r.status === "transport_failed") {
        b.transportFailed += 1;
      } else {
        b.pending += 1;
      }
    }

    // 4. Top 10 by submission count, then lookup names.
    const topPayerIds = [...byPayer.entries()]
      .sort((a, b) => b[1].submissionCount - a[1].submissionCount)
      .slice(0, 10)
      .map(([id]) => id);
    const payerInfo = new Map<
      string,
      { display_name: string; slug: string; line_of_business: string }
    >();
    if (topPayerIds.length > 0) {
      const { data: payers } = await supabase
        .schema("resupply")
        .from("payer_profiles")
        .select("id, slug, display_name, line_of_business")
        .in("id", topPayerIds);
      for (const p of payers ?? []) {
        payerInfo.set(p.id, {
          display_name: p.display_name,
          slug: p.slug,
          line_of_business: p.line_of_business,
        });
      }
    }

    res.json({
      window: { sinceIso: since, days: 30 },
      payers: topPayerIds.map((id) => {
        const b = byPayer.get(id)!;
        const info = payerInfo.get(id);
        const decided = b.accepted + b.rejected;
        return {
          payerProfileId: id,
          displayName: info?.display_name ?? "(unknown payer)",
          slug: info?.slug ?? null,
          lineOfBusiness: info?.line_of_business ?? null,
          submissionCount: b.submissionCount,
          claimCount: b.claimCount,
          acceptedCount: b.accepted,
          rejectedCount: b.rejected,
          transportFailedCount: b.transportFailed,
          pendingCount: b.pending,
          acceptanceRatePct:
            decided > 0
              ? Math.round((b.accepted / decided) * 1000) / 10
              : null,
        };
      }),
    });
  },
);

// ── HEALTH (transport + poll freshness) ─────────────────────────────
//
// "Is the OA pipe up?" — a single GET that the SPA renders as a
// green/yellow/red banner. Drives the outage banner on the OA
// Operations page so a CSR sees a transport failure before they
// drown in red rejections.
router.get(
  "/admin/office-ally/health",
  requirePermission("admin.tools.manage"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data } = await supabase
      .schema("resupply")
      .from("clearinghouse_credentials")
      .select("id, slug, display_name, is_active, last_polled_at")
      .eq("is_active", true)
      .order("last_polled_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    const lastPolledAt = data?.last_polled_at ?? null;
    const minutesSinceLastPoll = lastPolledAt
      ? Math.floor((Date.now() - new Date(lastPolledAt).getTime()) / 60000)
      : null;

    // Poll cron runs every 15 min — anything older than 60 min counts
    // as stale; > 240 min counts as outage. Null means we've never
    // polled (fresh deploy / no creds).
    const pollStatus: "fresh" | "stale" | "outage" | "never" = !lastPolledAt
      ? "never"
      : minutesSinceLastPoll! > 240
        ? "outage"
        : minutesSinceLastPoll! > 60
          ? "stale"
          : "fresh";

    // Look for any submission that landed in transport_failed in the
    // last hour — a sign the SFTP path is broken even if poll has
    // been running OK (poll uses the same creds so it'd usually fail
    // first, but submit can break independently when the inbound
    // share is OK but the outbound write isn't).
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: recentTransportFailures } = await supabase
      .schema("resupply")
      .from("office_ally_submissions")
      .select("id", { count: "exact", head: true })
      .eq("status", "transport_failed")
      .gte("submitted_at", oneHourAgo);

    res.json({
      hasActiveClearinghouse: !!data,
      activeClearinghouseSlug: data?.slug ?? null,
      activeClearinghouseName: data?.display_name ?? null,
      lastPolledAt,
      minutesSinceLastPoll,
      pollStatus,
      recentTransportFailures: recentTransportFailures ?? 0,
    });
  },
);

// ── EDI ENROLLMENT WATCHLIST ────────────────────────────────────────
// Quick read of payers whose `edi_enrollment_status` is anything but
// 'enrolled' or 'not_applicable' — i.e. payers we set up in the
// catalog but haven't yet been able to bill through OA. Powers the
// "N payers awaiting OA enrollment" banner on the OA Operations page
// so an op can see at a glance whether anything is stuck in OA's
// enrollment queue.
router.get(
  "/admin/office-ally/enrollment-watchlist",
  requirePermission("admin.tools.manage"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("payer_profiles")
      .select(
        "id, slug, display_name, line_of_business, edi_enrollment_status, office_ally_payer_id, requirements_last_verified_at",
      )
      .eq("is_active", true)
      .in("edi_enrollment_status", ["pending", "not_enrolled"])
      .order("display_name", { ascending: true })
      .limit(100);
    if (error) throw error;
    res.json({
      payers: (data ?? []).map((p) => ({
        id: p.id,
        slug: p.slug,
        displayName: p.display_name,
        lineOfBusiness: p.line_of_business,
        ediEnrollmentStatus: p.edi_enrollment_status,
        officeAllyPayerId: p.office_ally_payer_id,
        requirementsLastVerifiedAt: p.requirements_last_verified_at,
      })),
    });
  },
);

// ── CSV EXPORT (submissions) ────────────────────────────────────────
//
// MUST be registered before the `/:id` route below; otherwise the
// :id matcher catches "export.csv" and returns 404.
//
// Returns the submissions list as RFC-4180 CSV — one row per OA
// batch, with the same filterable shape as the JSON list endpoint
// (status, q) plus an optional `?days=` (default 90, max 365) so
// accountants can pull a quarter at a time. Used by:
//   * accounting — reconcile billed vs. accepted batches against
//     the GL
//   * OA support tickets — paste the CSV into an attachment
//   * internal audit — periodic compliance review
//
// Filename includes today's date so a sequence of exports doesn't
// collide on disk.
router.get(
  "/admin/office-ally-submissions/export.csv",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const daysRaw = typeof req.query.days === "string" ? Number(req.query.days) : 90;
    const days =
      Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 365
        ? Math.floor(daysRaw)
        : 90;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    let query = supabase
      .schema("resupply")
      .from("office_ally_submissions")
      .select(FULL_SELECT)
      .gte("submitted_at", since)
      .order("submitted_at", { ascending: false })
      .limit(5000);

    const statusFilter =
      typeof req.query.status === "string" ? req.query.status : undefined;
    if (statusFilter && isSubmissionStatus(statusFilter)) {
      query = query.eq("status", statusFilter);
    }
    const qRaw = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (qRaw.length > 0 && qRaw.length <= 80) {
      const safe = qRaw.replace(/[%_]/g, (m) => `\\${m}`);
      query = query.or(
        `isa_control_number.ilike.%${safe}%,file_name.ilike.%${safe}%`,
      );
    }
    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []).map(rowToApi);
    const filename = `oa-submissions-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.send(renderSubmissionsCsv(rows));
  },
);

// ── DETAIL incl linked claims, patient names, resubmit chain ──────
router.get(
  "/admin/office-ally-submissions/:id",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: submission, error } = await supabase
      .schema("resupply")
      .from("office_ally_submissions")
      .select(FULL_SELECT)
      .eq("id", parsed.data.id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!submission) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Linked claims = claims whose office_ally_submission_id matches
    // (set on accepted upload). For transport_failed rows this returns
    // empty; the page falls back to `attempted_claim_ids` below.
    const { data: linkedClaims } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select(
        "id, patient_id, payer_name, claim_number, date_of_service, status, total_billed_cents",
      )
      .eq("office_ally_submission_id", submission.id)
      .order("date_of_service", { ascending: false });

    // For transport_failed rows the linked-claims query returns
    // nothing (no claim got advanced); fall back to attempted_claim_ids
    // so the detail page can still show what we tried to send.
    const fallbackClaimIds =
      linkedClaims && linkedClaims.length > 0
        ? []
        : submission.attempted_claim_ids ?? [];
    const fallbackClaims =
      fallbackClaimIds.length > 0
        ? (
            await supabase
              .schema("resupply")
              .from("insurance_claims")
              .select(
                "id, patient_id, payer_name, claim_number, date_of_service, status, total_billed_cents",
              )
              .in("id", fallbackClaimIds)
          ).data ?? []
        : [];
    const claims = linkedClaims && linkedClaims.length > 0
      ? linkedClaims
      : fallbackClaims;

    // Patient name lookup (single-statement batch via .in()).
    const patientIds = [...new Set(claims.map((c) => c.patient_id))];
    const patientNames = new Map<string, string>();
    if (patientIds.length > 0) {
      const { data: patients } = await supabase
        .schema("resupply")
        .from("patients")
        .select("id, legal_first_name, legal_last_name")
        .in("id", patientIds);
      for (const p of patients ?? []) {
        patientNames.set(
          p.id,
          `${p.legal_first_name} ${p.legal_last_name}`.trim(),
        );
      }
    }

    // Resubmit lineage: optional parent (older row this one resubmits)
    // + optional children (rows that resubmit this one).
    const [parentRes, childrenRes] = await Promise.all([
      submission.parent_submission_id
        ? supabase
            .schema("resupply")
            .from("office_ally_submissions")
            .select(FULL_SELECT)
            .eq("id", submission.parent_submission_id)
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .schema("resupply")
        .from("office_ally_submissions")
        .select(FULL_SELECT)
        .eq("parent_submission_id", submission.id)
        .order("submitted_at", { ascending: false }),
    ]);

    // 277CA per-claim outcomes. The dispatcher in
    // worker/jobs/office-ally-inbound-poll.ts writes one
    // insurance_claim_events row per claim whose note begins with
    // "277CA accepted:" or "277CA rejected:". Fetch the latest such
    // event per claim so the detail page can render the per-claim
    // reject reason inline instead of forcing the op to scroll to
    // the events tab.
    const claimIds = claims.map((c) => c.id);
    const ackEvents = new Map<
      string,
      {
        outcome: "accepted" | "rejected" | "note";
        note: string;
        occurredAt: string;
      }
    >();
    if (claimIds.length > 0) {
      const { data: events } = await supabase
        .schema("resupply")
        .from("insurance_claim_events")
        .select("claim_id, event_type, note, occurred_at")
        .in("claim_id", claimIds)
        .in("event_type", ["denied", "note"])
        .like("note", "277CA%")
        .order("occurred_at", { ascending: false });
      // Keep only the newest 277CA event per claim. Iteration order
      // is DESC so the first one we see for a claim is the latest.
      for (const e of events ?? []) {
        if (ackEvents.has(e.claim_id)) continue;
        const note = e.note ?? "";
        const outcome: "accepted" | "rejected" | "note" = note.startsWith(
          "277CA rejected:",
        )
          ? "rejected"
          : note.startsWith("277CA accepted:")
            ? "accepted"
            : "note";
        ackEvents.set(e.claim_id, {
          outcome,
          note,
          occurredAt: e.occurred_at,
        });
      }
    }

    res.json({
      submission: rowToApi(submission),
      claims: claims.map((c) => {
        const ack = ackEvents.get(c.id) ?? null;
        return {
          id: c.id,
          patientId: c.patient_id,
          patientName: patientNames.get(c.patient_id) ?? null,
          payerName: c.payer_name,
          claimNumber: c.claim_number,
          dateOfService: c.date_of_service,
          status: c.status,
          totalBilledCents: c.total_billed_cents,
          // Per-claim 277CA outcome + reason. Null when no 277CA has
          // been received yet for this claim. `reason` strips the
          // "277CA accepted: " / "277CA rejected: " prefix so the UI
          // can render it raw.
          ack277ca: ack
            ? {
                outcome: ack.outcome,
                reason: ack.note.replace(/^277CA (accepted|rejected): /, ""),
                receivedAt: ack.occurredAt,
              }
            : null,
        };
      }),
      lineage: {
        parent: parentRes.data ? rowToApi(parentRes.data) : null,
        children: (childrenRes.data ?? []).map(rowToApi),
      },
    });
  },
);

// ── RAW 837P DOWNLOAD ──────────────────────────────────────────────
// Regenerates the exact 837P payload from the submission's linked
// claims and original ISA/GS control numbers. Used by the admin UI's
// "View raw 837P" download for audit + Office-Ally support tickets.
//
// PHI gate: the payload contains the full patient/claim payload that
// was sent. requireAdminOnly + the response carries no-store +
// Content-Disposition: attachment so it never lands in a browser
// cache or proxy intermediary.
router.get(
  "/admin/office-ally-submissions/:id/raw-837p",
  requireAdminOnly,
  adminRateLimit({
    name: "office_ally_submissions.raw_837p",
    preset: "sensitive",
  }),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const built = await buildEdiPayloadForSubmission(parsed.data.id);
    if (!built) {
      res.status(404).json({ error: "submission_unrecoverable" });
      return;
    }
    await logAudit({
      action: "office_ally_submission.download_raw_837p",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "office_ally_submissions",
      targetId: parsed.data.id,
      metadata: {
        usage_indicator: built.usageIndicator,
        size_bytes: Buffer.byteLength(built.payload, "utf8"),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "office_ally_submission.download_raw_837p audit write failed",
      );
    });
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="PF-837P-${parsed.data.id.slice(0, 8)}.txt"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.send(built.payload);
  },
);

// ── RESUBMIT ────────────────────────────────────────────────────────
// One-click recovery for `transport_failed` submissions. Forwards to
// the shared batch-submit core, recording parent_submission_id so the
// dashboard can show the resubmit chain. Only valid on a row whose
// upload failed at transport — once OA has accepted the file, the
// claims have already advanced and a true resubmit is a different
// (corrected-claim) flow.
router.post(
  "/admin/office-ally-submissions/:id/resubmit",
  requirePermission("admin.tools.manage"),
  adminRateLimit({
    name: "office_ally_submissions.resubmit",
    preset: "bulk",
  }),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: original } = await supabase
      .schema("resupply")
      .from("office_ally_submissions")
      .select("id, status, attempted_claim_ids")
      .eq("id", parsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!original) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (original.status !== "transport_failed") {
      res.status(409).json({
        error: "not_resubmittable",
        message:
          "only transport_failed submissions can be resubmitted (claims for accepted batches advance past draft, so a corrected-claim flow is needed instead)",
        currentStatus: original.status,
      });
      return;
    }
    const claimIds = original.attempted_claim_ids ?? [];
    if (claimIds.length === 0) {
      res.status(409).json({
        error: "no_attempted_claims",
        message:
          "this submission predates migration 0150 and has no recorded claim list; submit a fresh batch instead",
      });
      return;
    }
    const result = await executeOfficeAllyBatchSubmit({
      claimIds,
      parentSubmissionId: original.id,
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    if (!result.ok) {
      const status =
        result.kind === "no_claims_matched"
          ? 404
          : 409;
      res.status(status).json({ error: result.kind, ...result.detail });
      return;
    }
    res.status(result.uploadOk ? 201 : 502).json({
      ok: result.uploadOk,
      submissionId: result.submissionId,
      parentSubmissionId: original.id,
      claimCount: result.claimCount,
      isaControlNumber: result.isaControlNumber,
      gsControlNumber: result.gsControlNumber,
      transport: result.transport,
      uploadError: result.uploadError,
    });
  },
);

// ── PATCH — ack-file ingest + manual status edit ───────────────────
router.patch(
  "/admin/office-ally-submissions/:id",
  // Editing a submission row is operator-level: it changes downstream
  // claim status interpretation, and the ack rows are the auditable
  // truth source for billing reconciliation.
  requireAdminOnly,
  adminRateLimit({
    name: "office_ally_submissions.ack",
    preset: "sensitive",
  }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
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
    const b = parsed.data;
    const update: Database["resupply"]["Tables"]["office_ally_submissions"]["Update"] = {
      updated_at: new Date().toISOString(),
    };
    if (b.status !== undefined) update.status = b.status;
    if (b.ack999FileName !== undefined) update.ack_999_file_name = b.ack999FileName;
    if (b.ack999ReceivedAt !== undefined) update.ack_999_received_at = b.ack999ReceivedAt;
    if (b.ack277caFileName !== undefined) update.ack_277ca_file_name = b.ack277caFileName;
    if (b.ack277caReceivedAt !== undefined) update.ack_277ca_received_at = b.ack277caReceivedAt;
    if (b.rejectionReason !== undefined) update.rejection_reason = b.rejectionReason;

    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("office_ally_submissions")
      .update(update)
      .eq("id", idParsed.data.id);
    if (error) throw error;

    await logAudit({
      action: "office_ally_submission.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "office_ally_submissions",
      targetId: idParsed.data.id,
      metadata: {
        fields_changed: Object.keys(update).filter((k) => k !== "updated_at"),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "office_ally_submission.update audit write failed");
    });

    res.json({ ok: true });
  },
);

// CSV cell escaper per RFC 4180: wrap in quotes if the value
// contains a comma, quote, or newline; double any embedded quotes.
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = Array.isArray(v) ? v.join("|") : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function renderSubmissionsCsv(rows: ReturnType<typeof rowToApi>[]): string {
  const headers = [
    "Submitted At",
    "Status",
    "File Name",
    "ISA Control #",
    "GS Control #",
    "Claim Count",
    "File Size Bytes",
    "Submitted By",
    "999 Received At",
    "999 File",
    "277CA Received At",
    "277CA File",
    "Rejection Reason",
    "Parent Submission Id",
    "Submission Id",
  ];
  const lines: string[] = [headers.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.submittedAt,
        r.status,
        r.fileName,
        r.isaControlNumber,
        r.gsControlNumber,
        r.claimCount,
        r.fileSizeBytes,
        r.submittedByEmail,
        r.ack999ReceivedAt,
        r.ack999FileName,
        r.ack277caReceivedAt,
        r.ack277caFileName,
        r.rejectionReason,
        r.parentSubmissionId,
        r.id,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

function isSubmissionStatus(v: string): v is SubmissionStatus {
  return (STATUS_VALUES as readonly string[]).includes(v);
}

export default router;

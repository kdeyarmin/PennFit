// GET /admin/billing/dashboard
//
// Single round-trip the CSR loads every morning. Surfaces:
//
//   * draftClaims        — drafts older than N hours (default 24)
//                          that haven't been submitted yet.
//   * deniedClaims       — recent denials that need a worker.
//   * submittedNoAck     — claims submitted > 48h ago with no 999
//                          acceptance (or stuck at submitted).
//   * unmatchedEras      — era_files rows in status 'partial' that
//                          have unmatched claim blocks.
//   * fulfillmentsToBill — recent shipped fulfillments with no
//                          corresponding insurance_claims row.
//   * counts              — totals + dollar amounts for the period.
//
// Everything is read-only and aggregate. Per-claim PHI (patient name,
// member id) is NOT included; the UI deep-links by id.

import { Router, type IRouter } from "express";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const DRAFT_STALE_HOURS = 24;
const SUBMITTED_STUCK_HOURS = 48;
const RECENT_DENIAL_DAYS = 14;
const FULFILLMENT_TO_BILL_DAYS = 7;

router.get(
  "/admin/billing/dashboard",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    // Fail closed: never widen to all tenants on a missing orgId.
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const db = getOrgScopedClient(orgId);
    const now = Date.now();
    const draftStaleCutoff = new Date(
      now - DRAFT_STALE_HOURS * 3600 * 1000,
    ).toISOString();
    const stuckCutoff = new Date(
      now - SUBMITTED_STUCK_HOURS * 3600 * 1000,
    ).toISOString();
    const denialCutoff = new Date(
      now - RECENT_DENIAL_DAYS * 24 * 3600 * 1000,
    ).toISOString();
    const fulfillmentCutoff = new Date(
      now - FULFILLMENT_TO_BILL_DAYS * 24 * 3600 * 1000,
    ).toISOString();

    const results = await Promise.all([
      db
        .from("insurance_claims")
        .select(
          "id, patient_id, payer_name, total_billed_cents, created_at, updated_at",
        )
        .eq("status", "draft")
        .lte("created_at", draftStaleCutoff)
        .order("created_at", { ascending: true })
        .limit(50),
      db
        .from("insurance_claims")
        .select(
          "id, patient_id, payer_name, total_billed_cents, denial_reason, decision_at",
        )
        .eq("status", "denied")
        .gte("decision_at", denialCutoff)
        .order("decision_at", { ascending: false })
        .limit(50),
      db
        .from("insurance_claims")
        .select(
          "id, patient_id, payer_name, total_billed_cents, submitted_at, office_ally_submission_id",
        )
        .eq("status", "submitted")
        .lte("submitted_at", stuckCutoff)
        .order("submitted_at", { ascending: true })
        .limit(50),
      db
        .from("era_files")
        .select(
          "id, file_name, claims_paid_count, claims_denied_count, rejection_reason, ingested_at",
        )
        .eq("status", "partial")
        .order("ingested_at", { ascending: false })
        .limit(20),
      db
        .from("fulfillments")
        .select("id, patient_id, item_sku, quantity, shipped_at")
        .gte("shipped_at", fulfillmentCutoff)
        .order("shipped_at", { ascending: false })
        .limit(200),
    ]);
    // Surface query failures instead of rendering an "all clear"
    // dashboard: with only `data` destructured, any PostgREST error
    // (exposed-schema/permission/network) silently became "zero
    // drafts, zero denials, zero stuck claims" — hiding real billing
    // work. Same bug class the ai-billing-queue / inbox-counts fixes
    // call out in their comments.
    for (const r of results) {
      if (r.error) throw r.error;
    }
    // The org-scoped facade returns loosely-typed builder results, so
    // pin each result set to the shape its `.select(...)` requested.
    const drafts = (results[0].data ?? []) as Array<{
      id: string;
      patient_id: string | null;
      payer_name: string | null;
      total_billed_cents: number | null;
      created_at: string;
      updated_at: string;
    }>;
    const denied = (results[1].data ?? []) as Array<{
      id: string;
      patient_id: string | null;
      payer_name: string | null;
      total_billed_cents: number | null;
      denial_reason: string | null;
      decision_at: string | null;
    }>;
    const stuck = (results[2].data ?? []) as Array<{
      id: string;
      patient_id: string | null;
      payer_name: string | null;
      total_billed_cents: number | null;
      submitted_at: string | null;
      office_ally_submission_id: string | null;
    }>;
    const partialEras = (results[3].data ?? []) as Array<{
      id: string;
      file_name: string;
      claims_paid_count: number | null;
      claims_denied_count: number | null;
      rejection_reason: string | null;
      ingested_at: string | null;
    }>;
    const recentFulfillments = (results[4].data ?? []) as Array<{
      id: string;
      patient_id: string | null;
      item_sku: string;
      quantity: number | null;
      shipped_at: string | null;
    }>;

    // Filter fulfillments to "no claim yet". One batched lookup of every
    // fulfillment that already has a claim, instead of a count query per
    // row (up to 200 round-trips at the cap).
    const fulfillmentIds = (recentFulfillments ?? []).map((f) => f.id);
    const billedFulfillmentIds = new Set<string>();
    if (fulfillmentIds.length > 0) {
      const { data: claimedRows, error: claimedErr } = await db
        .from("insurance_claims")
        .select("fulfillment_id")
        .in("fulfillment_id", fulfillmentIds);
      if (claimedErr) throw claimedErr;
      for (const c of (claimedRows ?? []) as Array<{
        fulfillment_id: string | null;
      }>) {
        if (c.fulfillment_id) billedFulfillmentIds.add(c.fulfillment_id);
      }
    }
    const fulfillmentsToBill: typeof recentFulfillments = [];
    for (const f of recentFulfillments ?? []) {
      if (!billedFulfillmentIds.has(f.id)) fulfillmentsToBill.push(f);
      if (fulfillmentsToBill.length >= 25) break;
    }

    const totalDraftBilled = (drafts ?? []).reduce(
      (s, c) => s + (c.total_billed_cents ?? 0),
      0,
    );
    const totalDeniedBilled = (denied ?? []).reduce(
      (s, c) => s + (c.total_billed_cents ?? 0),
      0,
    );
    const totalStuckBilled = (stuck ?? []).reduce(
      (s, c) => s + (c.total_billed_cents ?? 0),
      0,
    );

    res.json({
      draftClaims: (drafts ?? []).map((c) => ({
        id: c.id,
        patientId: c.patient_id,
        payerName: c.payer_name,
        totalBilledCents: c.total_billed_cents,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      })),
      deniedClaims: (denied ?? []).map((c) => ({
        id: c.id,
        patientId: c.patient_id,
        payerName: c.payer_name,
        totalBilledCents: c.total_billed_cents,
        denialReason: c.denial_reason,
        decisionAt: c.decision_at,
      })),
      submittedNoAck: (stuck ?? []).map((c) => ({
        id: c.id,
        patientId: c.patient_id,
        payerName: c.payer_name,
        totalBilledCents: c.total_billed_cents,
        submittedAt: c.submitted_at,
        officeAllySubmissionId: c.office_ally_submission_id,
      })),
      unmatchedEras: (partialEras ?? []).map((e) => ({
        id: e.id,
        fileName: e.file_name,
        claimsPaid: e.claims_paid_count,
        claimsDenied: e.claims_denied_count,
        rejectionReason: e.rejection_reason,
        ingestedAt: e.ingested_at,
      })),
      fulfillmentsToBill: fulfillmentsToBill.map((f) => ({
        id: f.id,
        patientId: f.patient_id,
        itemSku: f.item_sku,
        quantity: f.quantity,
        shippedAt: f.shipped_at,
      })),
      counts: {
        draftStale: drafts?.length ?? 0,
        denied: denied?.length ?? 0,
        submittedNoAck: stuck?.length ?? 0,
        partialEras: partialEras?.length ?? 0,
        fulfillmentsToBill: fulfillmentsToBill.length,
      },
      dollars: {
        draftStaleBilledCents: totalDraftBilled,
        deniedBilledCents: totalDeniedBilled,
        submittedStuckBilledCents: totalStuckBilled,
      },
      thresholds: {
        draftStaleHours: DRAFT_STALE_HOURS,
        submittedStuckHours: SUBMITTED_STUCK_HOURS,
        recentDenialDays: RECENT_DENIAL_DAYS,
        fulfillmentToBillDays: FULFILLMENT_TO_BILL_DAYS,
      },
      generatedAt: new Date().toISOString(),
    });
  },
);

export default router;

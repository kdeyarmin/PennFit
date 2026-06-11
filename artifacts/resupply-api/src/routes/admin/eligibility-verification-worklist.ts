// /admin/billing/eligibility-verification-worklist — coverages due for
// (re-)verification (Biller #31, Phase 5 — the read-only half).
//
//   GET /admin/billing/eligibility-verification-worklist?staleDays=30
//
// The 270/271 round-trip already exists per-coverage; the missing piece
// is "which coverages should I re-check this week, before a claim denies
// for inactive coverage?" This ranks active coverages by verification
// urgency:
//   * never_verified  — no verified_at on file
//   * terminating_soon — termination_date within the lookahead window
//   * stale           — verified_at older than staleDays
//   * ok              — verified recently, not terminating
// The actual re-verify is still the operator-driven (or future batch)
// POST .../verify-eligibility — this surface only tells them WHO to do.
//
// reports.read-gated (billing-read). Coverage metadata only — payer /
// rank / member-id tail / dates; never the full member id or any
// clinical data. The ranking core is pure + unit-tested.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { runEligibilityReverificationBatch } from "../../lib/billing/eligibility-batch";

const router: IRouter = Router();

// The pure ranking core moved to lib/billing/eligibility-worklist.ts so
// the batch runner can share it without a route↔lib cycle. Imported for
// this route's handler + re-exported for back-compat with existing
// importers (this route's test).
import {
  buildVerificationWorklist,
  type VerificationStatus,
  type CoverageInput,
  type VerificationWorkItem,
  type VerificationWorklist,
} from "../../lib/billing/eligibility-worklist";

export {
  buildVerificationWorklist,
  type VerificationStatus,
  type CoverageInput,
  type VerificationWorkItem,
  type VerificationWorklist,
};

const querySchema = z
  .object({
    staleDays: z.coerce.number().int().min(1).max(365).optional(),
    includeOk: z.coerce.boolean().optional(),
  })
  .strip();

function memberIdTail(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw.slice(-4);
}

router.get(
  "/admin/billing/eligibility-verification-worklist",
  // Rate-limit before the auth gate (CodeQL "missing rate limiting").
  adminReadRateLimiter,
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    const staleDays = parsed.success ? (parsed.data.staleDays ?? 30) : 30;
    const includeOk = parsed.success ? (parsed.data.includeOk ?? false) : false;

    const supabase = getSupabaseServiceRoleClient();
    // Active coverages only: no termination date, or termination in the
    // future. (A coverage that already terminated is dead, not a
    // re-verify candidate.)
    const todayIso = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase
      .schema("resupply")
      .from("insurance_coverages")
      .select(
        "id, patient_id, rank, payer_name, member_id, verified_at, termination_date",
      )
      .or(`termination_date.is.null,termination_date.gte.${todayIso}`)
      .limit(2000);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    const rows = (data ?? []) as Array<Record<string, unknown>>;

    const worklist = buildVerificationWorklist(
      rows.map((r) => ({
        id: String(r.id),
        patientId: String(r.patient_id),
        rank: String(r.rank ?? ""),
        payerName: typeof r.payer_name === "string" ? r.payer_name : null,
        memberIdTail: memberIdTail(r.member_id),
        verifiedAt: typeof r.verified_at === "string" ? r.verified_at : null,
        terminationDate:
          typeof r.termination_date === "string" ? r.termination_date : null,
      })),
      { staleDays },
    );

    const items = includeOk
      ? worklist.items
      : worklist.items.filter((i) => i.status !== "ok");

    res.json({
      staleDays,
      items,
      counts: worklist.counts,
      generatedAt: new Date().toISOString(),
    });
  },
);

// POST /admin/billing/eligibility-batch-run — fire the re-verification
// batch on demand (Biller #31 write half). Operator-controlled entry to
// the same core the opt-in cron runs; returns a counts summary. Runs
// inline with a conservative cap, so it stays a few-second request even
// over SFTP. admin.tools.manage — it emits outbound clearinghouse 270s.
const batchRunSchema = z
  .object({
    cap: z.coerce.number().int().min(1).max(100).optional(),
    minHoursBetweenAttempts: z.coerce
      .number()
      .int()
      .min(0)
      .max(8760)
      .optional(),
    staleDays: z.coerce.number().int().min(1).max(365).optional(),
  })
  .strip();

router.post(
  "/admin/billing/eligibility-batch-run",
  requirePermission("admin.tools.manage"),
  // Dials/texts/emails patients or hammers the clearinghouse —
  // throttle like every sibling outbound-contact endpoint.
  adminRateLimit({ name: "billing.eligibility_batch_run", preset: "bulk" }),
  async (req, res) => {
    const parsed = batchRunSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const summary = await runEligibilityReverificationBatch(
      {
        cap: parsed.data.cap ?? 25,
        minHoursBetweenAttempts: parsed.data.minHoursBetweenAttempts,
        staleDays: parsed.data.staleDays,
        requestedByEmail: req.adminEmail ?? "admin:eligibility-batch",
      },
      { throttleMs: 100 },
    );
    req.log?.info(
      {
        event: "admin.eligibility_batch.run",
        ...summary,
        adminEmail: req.adminEmail,
      },
      "admin.eligibility_batch.run",
    );
    res.json({ summary });
  },
);

export default router;

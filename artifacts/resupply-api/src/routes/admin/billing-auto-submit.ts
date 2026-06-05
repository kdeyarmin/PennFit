// /admin/billing/auto-submit — the staged-approval half of automatic
// claim submission.
//
//   GET  /admin/billing/auto-submit/ready    — preview the claims that
//        are ready to transmit right now (preflight-clean + active
//        eligibility), grouped per payer, plus the excluded claims and
//        why each one failed the gate.
//   GET  /admin/billing/auto-submit/status    — automation status for the
//        page banner: is the unattended cron scheduled, is the feature
//        flag on, when did it last run.
//   POST /admin/billing/auto-submit/run       — operator approves a batch
//        (or "submit all ready"). Submits per payer through the same
//        Office Ally batch core the manual route uses.
//
// All three are admin.tools.manage-gated — the POST emits OUTBOUND
// clearinghouse traffic, so it carries the same gate as the manual
// batch-submit and eligibility-batch-run routes. The operator path does
// NOT consult the billing.auto_submit_claims feature flag (that flag
// only gates the UNATTENDED cron); an operator clicking submit is an
// explicit, attended action.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";

import {
  runAutoSubmitBatch,
  selectSubmissionReadyClaims,
  DEFAULT_MAX_CLAIMS_PER_RUN,
  MAX_CLAIMS_PER_BATCH,
} from "../../lib/billing/auto-submit-engine";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const readyQuery = z
  .object({
    maxClaims: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strip();

router.get(
  "/admin/billing/auto-submit/ready",
  adminReadRateLimiter,
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const parsed = readyQuery.safeParse(req.query);
    const maxClaims = parsed.success ? parsed.data.maxClaims : undefined;
    const readiness = await selectSubmissionReadyClaims({
      maxClaims: maxClaims ?? 100,
    });
    res.json(readiness);
  },
);

router.get(
  "/admin/billing/auto-submit/status",
  adminReadRateLimiter,
  requirePermission("admin.tools.manage"),
  async (_req, res) => {
    const flagEnabled = await isFeatureEnabled("billing.auto_submit_claims");
    const autoSubmitCron = process.env.CLAIMS_AUTOSUBMIT_CRON?.trim() || null;
    const eligibilityCron =
      process.env.ELIGIBILITY_REVERIFY_CRON?.trim() || null;
    res.json({
      autoSubmit: {
        // The cron only actually transmits when BOTH the schedule is
        // attached (env) AND the flag is on (admin Control Center).
        flagEnabled,
        cronConfigured: autoSubmitCron !== null,
        cronExpression: autoSubmitCron,
        active: flagEnabled && autoSubmitCron !== null,
        maxClaimsPerRun: DEFAULT_MAX_CLAIMS_PER_RUN,
        maxClaimsPerBatch: MAX_CLAIMS_PER_BATCH,
      },
      eligibilityAutoReverify: {
        cronConfigured: eligibilityCron !== null,
        cronExpression: eligibilityCron,
      },
    });
  },
);

const runBody = z
  .object({
    // When provided, only these (still-ready) claims are submitted. When
    // omitted, every ready claim up to maxClaims is submitted.
    claimIds: z.array(z.string().uuid()).min(1).max(500).optional(),
    maxClaims: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strip();

router.post(
  "/admin/billing/auto-submit/run",
  adminWriteRateLimiter,
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const parsed = runBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const result = await runAutoSubmitBatch({
      approvedClaimIds: parsed.data.claimIds,
      maxClaims: parsed.data.maxClaims,
      submittedByEmail: req.adminEmail ?? "admin:auto-submit",
      submittedByUserId: req.adminUserId ?? null,
      triggeredBy: "operator",
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });

    await logAudit({
      action: "billing.auto_submit.run",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "office_ally_submissions",
      targetId: null,
      metadata: {
        trigger: "operator",
        batches_attempted: result.batchesAttempted,
        claims_submitted: result.claimsSubmitted,
        failures: result.failures.length,
        skipped_not_ready: result.skippedNotReady.length,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "billing.auto_submit.run audit write failed");
    });

    req.log?.info(
      {
        event: "admin.billing.auto_submit.run",
        batchesAttempted: result.batchesAttempted,
        claimsSubmitted: result.claimsSubmitted,
        failures: result.failures.length,
        adminEmail: req.adminEmail,
      },
      "admin.billing.auto_submit.run",
    );
    res.json(result);
  },
);

export default router;

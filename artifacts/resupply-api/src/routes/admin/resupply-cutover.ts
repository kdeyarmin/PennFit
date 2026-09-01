// /admin/resupply-cutover — the per-tenant cutover workflow for the two
// resupply lifecycle flags.
//
//   GET  /admin/resupply-cutover                 both flags, current state + last verdict
//   POST /admin/resupply-cutover/:key/assess     run the dry-run readiness assessment
//   POST /admin/resupply-cutover/:key/enable     turn it on (requires a fresh clean pass)
//   POST /admin/resupply-cutover/:key/rollback   turn it back off, with a reason
//   GET  /admin/resupply-cutover/:key/history    the audit trail
//
// WHY THIS EXISTS INSTEAD OF THE FEATURE-FLAG TOGGLE
// -------------------------------------------------
// `resupply.due_at_authoritative` and `resupply.ship_evidence_required`
// are reachable from /admin/feature-flags like any other switch, and
// through that door they are two clicks with no evidence behind them.
// Each changes WHEN a live patient is next contacted: flipped on a tenant
// whose data is not ready, one produces a reminder burst across the whole
// book on the first tick and the other makes a cohort go silent. Neither
// failure is visible until patients call.
//
// So enabling goes through here, where it is gated on a fresh, clean,
// recorded assessment of THAT tenant, and every decision leaves a row
// naming the evidence it was based on.
//
// The generic toggle still exists and is not disabled — locking a flag
// out of the flags page would be a lie about where the switch lives, and
// an operator with `admin.tools.manage` can always reach it. What this
// adds is the supported path, and the record that says which one was
// used: a flag enabled here has a `resupply_cutover_records` row, and one
// enabled from the flags page does not. `GET /admin/resupply-cutover`
// reports that difference rather than hiding it.
//
// PHI: readiness reports carry counts, day-deltas, and capped samples of
// INTERNAL episode/fulfillment UUIDs. No names, contact details, payer,
// address or clinical content.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient } from "@workspace/resupply-db";

import {
  CUTOVER_FLAG_KEYS,
  READINESS_TTL_DAYS,
  assessReadiness,
  listCutoverRecords,
  readCutoverFlagState,
  readLatestCutoverRecord,
  resolveReadinessState,
  writeCutoverRecord,
  type CutoverFlagKey,
} from "@workspace/resupply-cutover";

import { invalidateFeatureFlagCache } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

/**
 * The confirmation an operator must type. Not a boolean: a boolean is
 * something a script sets to true by default. This has to be produced on
 * purpose, and it names what is about to happen.
 */
const ENABLE_CONFIRMATION = "ENABLE";
const ROLLBACK_CONFIRMATION = "ROLLBACK";

const keyParam = z.object({ key: z.enum(CUTOVER_FLAG_KEYS) });

const assessBody = z
  .object({
    /** Raise the row budget for a large tenant. */
    maxEpisodes: z.number().int().min(100).max(500_000).optional(),
    windowDays: z.number().int().min(7).max(730).optional(),
    unresolvedShipmentFailureThreshold: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .optional(),
    evidenceId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const enableBody = z
  .object({
    confirm: z.literal(ENABLE_CONFIRMATION),
    evidenceId: z.string().trim().min(1).max(200),
  })
  .strict();

const rollbackBody = z
  .object({
    confirm: z.literal(ROLLBACK_CONFIRMATION),
    reason: z.string().trim().min(10).max(1000),
    evidenceId: z.string().trim().max(200).optional(),
  })
  .strict();

/** Flip the flag row. Returns the previous value. */
async function setFlag(
  orgId: string,
  key: CutoverFlagKey,
  enabled: boolean,
  actor: { email: string | null; userId: string | null },
): Promise<{ previous: boolean } | { error: "flag_not_seeded" }> {
  const supabase = getOrgScopedClient(orgId).raw();
  const { data: prior, error: priorErr } = await supabase
    .schema("resupply")
    .from("feature_flags")
    .select("key, enabled")
    .eq("org_id", orgId)
    .eq("key", key)
    .maybeSingle();
  if (priorErr) throw priorErr;
  if (!prior) return { error: "flag_not_seeded" };

  const previous = Boolean((prior as { enabled: boolean }).enabled);
  if (previous === enabled) return { previous };

  const { error: updateErr } = await supabase
    .schema("resupply")
    .from("feature_flags")
    .update({
      enabled,
      updated_by_user_id: actor.userId,
      updated_by_email: actor.email,
      updated_at: new Date().toISOString(),
    })
    .eq("org_id", orgId)
    .eq("key", key);
  if (updateErr) throw updateErr;

  invalidateFeatureFlagCache(key);
  return { previous };
}

router.get(
  "/admin/resupply-cutover",
  requirePermission("reports.read"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const now = new Date();
    const flags = [];
    for (const key of CUTOVER_FLAG_KEYS) {
      const [enabled, latest] = await Promise.all([
        readCutoverFlagState(orgId, key),
        readLatestCutoverRecord(orgId, key),
      ]);
      const { state, ageDays } = resolveReadinessState(latest, now);
      flags.push({
        key,
        enabled,
        readinessState: state,
        assessmentAgeDays: ageDays,
        readinessTtlDays: READINESS_TTL_DAYS,
        lastRecord: latest
          ? {
              id: latest.id,
              action: latest.action,
              readinessStatus: latest.readinessStatus,
              evidenceId: latest.evidenceId,
              actorEmail: latest.actorEmail,
              evaluatedAt: latest.evaluatedAt,
              rollbackReason: latest.rollbackReason,
            }
          : null,
        // A flag that is ON with no `enable` record was flipped from the
        // generic feature-flags page, bypassing the assessment. Saying so
        // is more useful than pretending the workflow was followed.
        enabledWithoutRecord:
          enabled && (latest === null || latest.action !== "enable"),
      });
    }
    res.json({ flags });
  },
);

router.post(
  "/admin/resupply-cutover/:key/assess",
  requirePermission("reports.read"),
  adminRateLimit({ name: "resupply_cutover.assess", preset: "mutation" }),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const params = keyParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "unknown_flag" });
      return;
    }
    const body = assessBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: body.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const key = params.data.key;
    let report;
    try {
      report = await assessReadiness(orgId, key, body.data);
    } catch (err) {
      // An assessment that FAILED is recorded as an assessment that
      // failed, not silently dropped — otherwise a tenant looks
      // unevaluated when in fact the evaluation is broken.
      logger.warn(
        {
          event: "resupply.cutover.assess_failed",
          orgId,
          flagKey: key,
          errName: err instanceof Error ? err.name : "unknown",
        },
        "resupply cutover: readiness assessment failed",
      );
      await writeCutoverRecord({
        orgId,
        flagKey: key,
        action: "evaluate",
        previousValue: null,
        newValue: null,
        readinessStatus: "error",
        report: { error: "assessment_failed" },
        evidenceId: body.data.evidenceId ?? null,
        actorEmail: req.adminEmail ?? null,
        actorUserId: req.adminUserId ?? null,
      }).catch(() => undefined);
      res.status(503).json({ error: "assessment_failed" });
      return;
    }

    const record = await writeCutoverRecord({
      orgId,
      flagKey: key,
      action: "evaluate",
      previousValue: null,
      newValue: null,
      readinessStatus: report.status,
      report: report as unknown as Record<string, unknown>,
      evidenceId: body.data.evidenceId ?? null,
      actorEmail: req.adminEmail ?? null,
      actorUserId: req.adminUserId ?? null,
    });

    res.json({ report, recordId: record.id });
  },
);

router.post(
  "/admin/resupply-cutover/:key/enable",
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "resupply_cutover.enable", preset: "mutation" }),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const params = keyParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "unknown_flag" });
      return;
    }
    const body = enableBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({
        error: "confirmation_required",
        detail:
          `Enabling this flag changes when live patients are contacted. Send ` +
          `{"confirm":"${ENABLE_CONFIRMATION}","evidenceId":"<ticket>"}.`,
      });
      return;
    }

    const key = params.data.key;

    // Re-assess NOW rather than trusting the stored verdict. A tenant
    // that passed an hour ago can have imported a book of patients since,
    // and the stored record is what authorises the click, not what
    // decides the outcome. Both must agree.
    let report;
    try {
      report = await assessReadiness(orgId, key);
    } catch {
      res.status(503).json({ error: "assessment_failed" });
      return;
    }

    if (report.status !== "ready") {
      await writeCutoverRecord({
        orgId,
        flagKey: key,
        action: "evaluate",
        previousValue: null,
        newValue: null,
        readinessStatus: report.status,
        report: report as unknown as Record<string, unknown>,
        evidenceId: body.data.evidenceId,
        actorEmail: req.adminEmail ?? null,
        actorUserId: req.adminUserId ?? null,
      }).catch(() => undefined);
      res.status(409).json({
        error: "not_ready",
        report,
      });
      return;
    }

    const flagResult = await setFlag(orgId, key, true, {
      email: req.adminEmail ?? null,
      userId: req.adminUserId ?? null,
    });
    if ("error" in flagResult) {
      res.status(404).json({ error: flagResult.error, key });
      return;
    }

    // The flag is now ON. There are no cross-request transactions on this
    // data path, so the record cannot be written atomically with the flip
    // — which leaves exactly one dangerous window: the record fails, the
    // response says "error", and the operator reasonably believes nothing
    // happened while the flag is quietly enabled with no evidence behind
    // it. That is the state `flags_without_readiness_evidence` exists to
    // catch, and it should not be reachable through the supported path.
    //
    // So on a failed record we put the flag BACK. The invariant worth
    // protecting is "never enabled without evidence"; a flag left off
    // after a failed enable is merely a retry.
    let record;
    try {
      record = await writeCutoverRecord({
        orgId,
        flagKey: key,
        action: "enable",
        previousValue: flagResult.previous,
        newValue: true,
        readinessStatus: "ready",
        report: report as unknown as Record<string, unknown>,
        evidenceId: body.data.evidenceId,
        actorEmail: req.adminEmail ?? null,
        actorUserId: req.adminUserId ?? null,
      });
    } catch (err) {
      const reverted = await setFlag(orgId, key, flagResult.previous, {
        email: req.adminEmail ?? null,
        userId: req.adminUserId ?? null,
      }).catch(() => null);
      const rolledBack = reverted !== null && !("error" in reverted);
      logger.error(
        {
          event: "resupply_cutover.record_failed",
          flagKey: key,
          rolledBack,
          errName: err instanceof Error ? err.name : "unknown",
        },
        rolledBack
          ? "resupply-cutover: could not record the enable; the flag was put back"
          : "resupply-cutover: could not record the enable AND could not put the flag back — it is ON with no evidence",
      );
      invalidateFeatureFlagCache();
      res.status(500).json({
        // Two different states, and the operator has to act differently
        // in each. Reporting them the same way is how the second one
        // goes unnoticed.
        error: rolledBack
          ? "record_failed_flag_reverted"
          : "record_failed_flag_still_enabled",
        key,
        ...(rolledBack
          ? {}
          : {
              message:
                "The flag is enabled with no cutover record. Roll it back " +
                "from this page, or re-run the enable so a record is written.",
            }),
      });
      return;
    }

    await logAudit({
      action: "resupply_cutover.enable",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "feature_flags",
      targetId: key,
      metadata: { key, from: flagResult.previous, to: true },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch(() => undefined);

    logger.info(
      {
        event: "resupply.cutover.enabled",
        orgId,
        flagKey: key,
        evidenceId: body.data.evidenceId,
        recordId: record.id,
      },
      "resupply cutover: flag enabled after a clean readiness assessment",
    );

    res.json({ enabled: true, recordId: record.id, report });
  },
);

router.post(
  "/admin/resupply-cutover/:key/rollback",
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "resupply_cutover.rollback", preset: "mutation" }),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const params = keyParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "unknown_flag" });
      return;
    }
    const body = rollbackBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({
        error: "confirmation_required",
        detail:
          `Send {"confirm":"${ROLLBACK_CONFIRMATION}","reason":"<why, >=10 chars>"}. ` +
          "A rollback without a reason is indistinguishable from a flag that " +
          "was never turned on.",
      });
      return;
    }

    const key = params.data.key;

    // Rollback is DELIBERATELY not gated on readiness. Turning a flag
    // back off restores the behaviour every tenant has today; requiring
    // an assessment first would put a data-quality check between an
    // operator and the stop button.
    const flagResult = await setFlag(orgId, key, false, {
      email: req.adminEmail ?? null,
      userId: req.adminUserId ?? null,
    });
    if ("error" in flagResult) {
      res.status(404).json({ error: flagResult.error, key });
      return;
    }

    const record = await writeCutoverRecord({
      orgId,
      flagKey: key,
      action: "rollback",
      previousValue: flagResult.previous,
      newValue: false,
      // The rollback itself is not an assessment; recording it as
      // `blocked` keeps the next `enable` from finding a stale `ready`.
      readinessStatus: "blocked",
      report: { rolledBackFrom: flagResult.previous },
      evidenceId: body.data.evidenceId ?? null,
      rollbackReason: body.data.reason,
      actorEmail: req.adminEmail ?? null,
      actorUserId: req.adminUserId ?? null,
    });

    await logAudit({
      action: "resupply_cutover.rollback",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "feature_flags",
      targetId: key,
      metadata: { key, from: flagResult.previous, to: false },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch(() => undefined);

    logger.warn(
      {
        event: "resupply.cutover.rolled_back",
        orgId,
        flagKey: key,
        recordId: record.id,
      },
      "resupply cutover: flag rolled back",
    );

    res.json({ enabled: false, recordId: record.id });
  },
);

router.get(
  "/admin/resupply-cutover/:key/history",
  requirePermission("reports.read"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const params = keyParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "unknown_flag" });
      return;
    }
    const records = await listCutoverRecords(orgId, params.data.key);
    res.json({ records });
  },
);

export default router;

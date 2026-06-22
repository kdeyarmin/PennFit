// pg-boss job: scheduled automatic Da Vinci PAS submission of draft prior
// authorizations.
//
// Selects DRAFT prior_authorizations that already carry an
// insurance_coverage_id and front-loads each through the SAME
// submitPriorAuth() core the manual route uses (lib/billing/submit-prior-auth.ts)
// — so the bundle-build + SSRF-pin + identifier-binding path never diverges.
// Every other precondition (diagnosis on file, payer PAS endpoint, per-payer
// credentials, patient address) is validated inside the helper, which returns
// an `ok: false` no-op result — inserting nothing and calling no payer — when a
// PA isn't ready. A not-yet-ready draft is therefore simply skipped and retried
// next tick, never a guaranteed-reject transmission.
//
// SAFETY — two independent off switches, both required to transmit (mirrors
// the claims auto-submit job, billing.auto_submit_claims):
//
//   1. OPT-IN CRON. The queue + worker always register, but the recurring
//      schedule attaches only when PRIOR_AUTH_AUTOSUBMIT_CRON is set.
//   2. RUNTIME FEATURE FLAG. The job checks billing.auto_submit_prior_auths
//      (seeded DISABLED, migration 0433) on every tick and no-ops when off.

import type PgBoss from "pg-boss";

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { submitPriorAuth } from "../../lib/billing/submit-prior-auth.js";
import { isFeatureEnabled } from "../../lib/feature-flags.js";
import { logger } from "../../lib/logger.js";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options.js";

export const PRIOR_AUTH_AUTO_SUBMIT_JOB = "billing.prior-auth-auto-submit";

const SYSTEM_ACTOR_EMAIL = "system:worker:prior-auth-auto-submit";

// Cap per tick so one run can't fan out an unbounded number of payer POSTs.
const MAX_PER_TICK = 25;

export async function registerPriorAuthAutoSubmitJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(
    boss,
    PRIOR_AUTH_AUTO_SUBMIT_JOB,
    VENDOR_SEND_QUEUE_OPTS,
  );
  await boss.work(PRIOR_AUTH_AUTO_SUBMIT_JOB, async () => {
    const enabled = await isFeatureEnabled("billing.auto_submit_prior_auths");
    if (!enabled) {
      logger.info(
        { queue: PRIOR_AUTH_AUTO_SUBMIT_JOB },
        "prior-auth-auto-submit: feature flag off — nothing transmitted",
      );
      return;
    }

    // Cron path operates on the seed org, like the claims auto-submit cron.
    const orgId = await resolveSeedOrgId();
    if (!orgId) {
      logger.warn(
        { queue: PRIOR_AUTH_AUTO_SUBMIT_JOB },
        "prior-auth-auto-submit: no seed org resolved — skipping",
      );
      return;
    }

    const supabase = getOrgScopedClient(orgId);
    const { data: drafts, error } = await supabase
      .from("prior_authorizations")
      .select("id, patient_id")
      .eq("status", "draft")
      .not("insurance_coverage_id", "is", null)
      .order("created_at", { ascending: true })
      .limit(MAX_PER_TICK);
    if (error) throw error;

    let submitted = 0;
    let skipped = 0;
    let failed = 0;
    for (const pa of drafts ?? []) {
      try {
        const result = await submitPriorAuth({
          orgId,
          patientId: pa.patient_id,
          paId: pa.id,
          actorEmail: SYSTEM_ACTOR_EMAIL,
        });
        if (!result.ok) {
          // Not ready (no diagnosis/endpoint/creds/address) — left as a draft
          // and retried next tick. No payer call, no submission row.
          skipped += 1;
        } else if (result.transportStatus === "responded") {
          submitted += 1;
        } else {
          // Transmitted but the payer transport failed — counts as an attempt.
          submitted += 1;
        }
      } catch (err) {
        failed += 1;
        logger.warn(
          { event: "prior-auth-auto-submit.item_failed", paId: pa.id, err },
          "prior-auth-auto-submit: a PA submission threw",
        );
      }
    }

    if (submitted > 0 || failed > 0) {
      logger.info(
        {
          event: "billing.prior-auth-auto-submit.completed",
          candidates: drafts?.length ?? 0,
          submitted,
          skipped,
          failed,
        },
        "billing.prior-auth-auto-submit: tick",
      );
    }
  });

  const cron = process.env.PRIOR_AUTH_AUTOSUBMIT_CRON?.trim();
  if (cron) {
    await boss.schedule(PRIOR_AUTH_AUTO_SUBMIT_JOB, cron);
    logger.info(
      { queue: PRIOR_AUTH_AUTO_SUBMIT_JOB, cron },
      "prior-auth-auto-submit: recurring schedule attached",
    );
  }
}

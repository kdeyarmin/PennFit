// pg-boss job: daily auto-staging of resupply order drafts.
//
// The therapy_resupply_opportunities RPC computes, per tenant, the supplies
// whose plan next-eligible date has arrived (from the nightly device
// snapshots). This job turns that read-only worklist into staged PROPOSALS
// — a draft per due supply — so a CSR opens a ready-to-review queue instead
// of eyeballing the opportunities list. It does NOT create orders or charge
// anyone: a CSR reviews each draft, picks the SKU, and approves it into the
// sign-&-pay flow.
//
// Gating: per-tenant `resupply.auto_order_drafts` flag (seeded OFF,
// migration 0391). When off, the tenant is skipped entirely — a CSR can
// still stage drafts manually from the opportunities page. Idempotent:
// stageResupplyDrafts skips any (patient, category, eligible-date) that
// already has an open draft, so re-runs don't pile up duplicates. Internal
// only — no patient contact, so no consent/quiet-hours gate applies here.

import type PgBoss from "pg-boss";

import {
  type OrgScopedClient,
  getOrgScopedClient,
} from "@workspace/resupply-db";

import { isFeatureEnabled } from "../../lib/feature-flags.js";
import { logger } from "../../lib/logger.js";
import {
  type DraftSeed,
  stageResupplyDrafts,
} from "../../lib/resupply/resupply-draft-staging.js";
import { forEachActiveOrg } from "../lib/for-each-active-org.js";
import {
  createQueueWithDlq,
  CRON_SCAN_QUEUE_OPTS,
} from "../lib/queue-options.js";

export const RESUPPLY_AUTO_DRAFT_JOB = "resupply.auto-draft";

// Eligible NOW (dueWithinDays = 0). The opportunities RPC caps at 1000;
// match the other fleet jobs.
const DUE_WITHIN_DAYS = 0;
const OPPORTUNITY_LIMIT = 1000;

export interface ResupplyAutoDraftResult {
  orgsProcessed: number;
  eligible: number;
  staged: number;
  skipped: number;
}

export async function registerResupplyAutoDraftJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(boss, RESUPPLY_AUTO_DRAFT_JOB, CRON_SCAN_QUEUE_OPTS);
  await boss.work(RESUPPLY_AUTO_DRAFT_JOB, async () => {
    await runResupplyAutoDraft();
  });
  // 05:30 UTC — after the 04:30 nightly therapy sync, so the snapshots the
  // opportunities RPC reads are fresh. No patient contact, so the time of
  // day is otherwise immaterial.
  await boss.schedule(RESUPPLY_AUTO_DRAFT_JOB, "30 5 * * *");
  logger.info(
    { queue: RESUPPLY_AUTO_DRAFT_JOB },
    "resupply auto-draft worker registered",
  );
}

interface OpportunityRpcRow {
  patient_id: string;
  source: string | null;
  category: string;
  description: string | null;
  next_eligible_date: string | null;
}

export async function runResupplyAutoDraft(): Promise<ResupplyAutoDraftResult> {
  const result: ResupplyAutoDraftResult = {
    orgsProcessed: 0,
    eligible: 0,
    staged: 0,
    skipped: 0,
  };
  await forEachActiveOrg(
    async (orgId) => {
      await autoDraftForOrg(orgId, result);
    },
    { jobName: RESUPPLY_AUTO_DRAFT_JOB },
  );
  return result;
}

async function autoDraftForOrg(
  orgId: string,
  result: ResupplyAutoDraftResult,
): Promise<void> {
  result.orgsProcessed += 1;

  const enabled = await isFeatureEnabled("resupply.auto_order_drafts", orgId);
  if (!enabled) {
    logger.info(
      { queue: RESUPPLY_AUTO_DRAFT_JOB, orgId, enabled: false },
      "resupply auto-draft skipped (flag off)",
    );
    return;
  }

  const supabase: OrgScopedClient = getOrgScopedClient(orgId);
  const { data, error } = await supabase
    .raw()
    .schema("resupply")
    .rpc("therapy_resupply_opportunities", {
      p_due_within_days: DUE_WITHIN_DAYS,
      p_limit: OPPORTUNITY_LIMIT,
    });
  if (error) throw error;

  const seeds: DraftSeed[] = ((data ?? []) as OpportunityRpcRow[])
    .filter((r) => r.patient_id && r.category)
    .map((r) => ({
      patientId: r.patient_id,
      category: r.category,
      source: r.source,
      sourceDescription: r.description,
      nextEligibleDate: r.next_eligible_date,
    }));
  result.eligible += seeds.length;

  const { staged, skipped } = await stageResupplyDrafts(supabase, seeds, {
    origin: "auto",
    createdByUserId: `system:${RESUPPLY_AUTO_DRAFT_JOB}`,
  });
  result.staged += staged;
  result.skipped += skipped;

  logger.info(
    {
      queue: RESUPPLY_AUTO_DRAFT_JOB,
      orgId,
      eligible: seeds.length,
      staged,
      skipped,
    },
    "resupply auto-draft complete (tenant)",
  );
}

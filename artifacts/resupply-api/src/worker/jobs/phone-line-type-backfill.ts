// pg-boss job: phone line-type backfill.
//
// Classifies (via Twilio Lookup) the phone line type of patients and shop
// customers that have a phone on file but no line type yet, caching the
// result on the row. This is what makes the "SMS only to cellular" gate
// meaningful over time: numbers captured before classification, or that
// never went through the on-write lookup, get filled in here.
//
// Posture:
//   * No-op when Twilio Lookup isn't configured (creds unset).
//   * Skips rows already classified (phone_line_type set) and manual
//     overrides (classifyAndCachePhoneLineType guards on source='manual').
//   * Bounded per org per run (MAX_LOOKUPS_PER_ORG) to cap Lookup spend;
//     the next nightly run picks up the remainder.
//   * Per-tenant isolation via forEachActiveOrg — one tenant's failure
//     never aborts the rest.

import type PgBoss from "pg-boss";

import { getOrgScopedClient } from "@workspace/resupply-db";

import {
  classifyAndCachePhoneLineType,
  readLookupClientOrNull,
  type LineTypeRecipientKind,
} from "../../lib/messaging/phone-line-type.js";
import { logger } from "../../lib/logger.js";
import { forEachActiveOrg } from "../lib/for-each-active-org.js";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options.js";

export const PHONE_LINE_TYPE_BACKFILL_JOB = "phone-line-type.backfill";

// Cap Lookup calls per tenant per run so a large unclassified backlog can't
// run up an unbounded Twilio Lookup bill in one tick; the remainder is
// picked up on the next nightly run.
const MAX_LOOKUPS_PER_ORG = 200;
// PostgREST page size for scanning candidate rows.
const PAGE = 200;

export async function registerPhoneLineTypeBackfillJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(boss, PHONE_LINE_TYPE_BACKFILL_JOB, {
    ...VENDOR_SEND_QUEUE_OPTS,
    // Lookup calls + a throttle make a full page take minutes; give it room.
    expireInMinutes: 30,
  });
  await boss.work(PHONE_LINE_TYPE_BACKFILL_JOB, async () => {
    await runPhoneLineTypeBackfill();
  });
  // Nightly at 05:00 UTC (after the therapy nightly sync at 04:30).
  await boss.schedule(PHONE_LINE_TYPE_BACKFILL_JOB, "0 5 * * *");
  logger.info(
    { queue: PHONE_LINE_TYPE_BACKFILL_JOB },
    "phone line-type backfill worker registered",
  );
}

export async function runPhoneLineTypeBackfill(): Promise<void> {
  const client = readLookupClientOrNull();
  if (!client) {
    logger.info(
      { job: PHONE_LINE_TYPE_BACKFILL_JOB },
      "phone-line-type.backfill: Twilio Lookup not configured — skipping",
    );
    return;
  }
  await forEachActiveOrg(
    async (orgId) => {
      await runPhoneLineTypeBackfillForOrg(orgId);
    },
    { jobName: PHONE_LINE_TYPE_BACKFILL_JOB },
  );
}

export async function runPhoneLineTypeBackfillForOrg(
  orgId: string,
): Promise<{ classified: number }> {
  const client = readLookupClientOrNull();
  if (!client) return { classified: 0 };
  const supabase = getOrgScopedClient(orgId);
  // `attempts` bounds the BILLABLE work: each classify call may issue a Twilio
  // Lookup, so the per-run cap counts attempts (not just successful writes) —
  // otherwise a tenant with many un-classifiable rows (un-normalizable phones,
  // transient write errors) could drive unbounded Lookup spend and re-scan the
  // same rows every night. `classified` is tracked only for the summary log.
  let attempts = 0;
  let classified = 0;

  for (const kind of ["patient", "shop_customer"] as LineTypeRecipientKind[]) {
    if (attempts >= MAX_LOOKUPS_PER_ORG) break;
    const table = kind === "patient" ? "patients" : "shop_customers";
    const idCol = kind === "patient" ? "id" : "customer_id";
    // Scan candidates: a phone on file, not yet classified. (A manual
    // override always has a type set, so it's excluded by the null filter;
    // the classify helper guards manual again at write time.)
    const { data, error } = await supabase
      .from(table)
      .select(idCol)
      .not("phone_e164", "is", null)
      .is("phone_line_type", null)
      .order(idCol, { ascending: true })
      .range(0, PAGE - 1);
    if (error) {
      logger.warn(
        // Pass the error OBJECT so the logger's err.* redaction applies.
        { job: PHONE_LINE_TYPE_BACKFILL_JOB, orgId, kind, err: error },
        "phone-line-type.backfill: candidate scan failed",
      );
      continue;
    }
    for (const row of data ?? []) {
      if (attempts >= MAX_LOOKUPS_PER_ORG) break;
      const id = (row as Record<string, string>)[idCol];
      if (!id) continue;
      attempts += 1;
      const lineType = await classifyAndCachePhoneLineType({
        orgId,
        kind,
        id,
        client,
      });
      if (lineType) classified += 1;
    }
  }

  if (attempts > 0) {
    logger.info(
      { job: PHONE_LINE_TYPE_BACKFILL_JOB, orgId, attempts, classified },
      "phone-line-type.backfill: classified numbers for tenant",
    );
  }
  return { classified };
}

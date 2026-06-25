// pg-boss jobs: patient AR dunning engine — open-scan + tick.
//
// Two cooperating jobs, both per-tenant and both gated by the
// collections.dunning feature flag (no-op when off):
//
//   * open-scan (collections.dunning-open-scan) — finds patients whose open
//     AR clears the floor and who are NOT on a plan / autopay and have no
//     active run, and opens a dunning run (first step due now).
//   * tick (collections.dunning-tick) — walks due active runs, recomputes the
//     balance, and applies the pure ladder decision (resolve / pause / send /
//     handoff). Sends reuse the EXISTING statement path (pickStatementChannel
//     + sendStatementMessage), so consent + quiet-hours are enforced exactly
//     as a hand-sent statement. The agency step never auto-sends — the run is
//     parked for the reviewed collections export.
//
// Both opt-in cron (COLLECTIONS_DUNNING_*_CRON); the flag gate makes a fixed
// schedule safe. PHI: events store reason codes + amounts only, never message
// bodies or patient identifiers.

import type PgBoss from "pg-boss";

import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  type DunningStep,
  DUNNING_MIN_BALANCE_CENTS,
  decideDunningAction,
  nextDunningStep,
} from "@workspace/resupply-domain";

import {
  applyTenantStatementIdentity,
  pickStatementChannel,
  readStatementMessagingConfig,
  readStatementPrefs,
  sendStatementMessage,
} from "../../lib/billing/statement-send";
import { practiceTodayIso } from "../../lib/billing-date";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { forEachActiveOrg } from "../lib/for-each-active-org";
import { createQueueWithDlq, CRON_SCAN_QUEUE_OPTS } from "../lib/queue-options";

const OPEN_SCAN_JOB = "collections.dunning-open-scan";
const TICK_JOB = "collections.dunning-tick";
const OPEN_SCAN_CRON =
  process.env.COLLECTIONS_DUNNING_SCAN_CRON?.trim() || "17 5 * * *";
const TICK_CRON =
  process.env.COLLECTIONS_DUNNING_TICK_CRON?.trim() || "0 18 * * *";

// Cap the per-tenant candidate set so a large AR backlog is chipped at over
// several nights rather than hammering the DB in one tick.
const MAX_CANDIDATES = 500;
const MAX_TICK = 500;

type Supabase = ReturnType<typeof getOrgScopedClient>;

// Claim statuses that are billable to the patient — same set the statement
// path uses (statement-generation.ts). Draft/submitted/accepted carry only
// PROVISIONAL patient responsibility and must not enter the dunning ladder.
const BILLABLE_CLAIM_STATUSES = [
  "partially_paid",
  "paid",
  "denied",
  "appealed",
  "closed",
] as const;

/**
 * Open patient AR = the sum of live `patient_responsibility_cents` on billable
 * claims. That column is ALREADY net of applied payments — the
 * `apply_patient_payment` RPC (migration 0214) decrements it on every
 * succeeded payment — so we must NOT subtract patient_payments again (that
 * would double-count and zero out partially-paid patients prematurely).
 */
async function computeBalanceCents(
  supabase: Supabase,
  patientId: string,
): Promise<number> {
  // Surface read failures instead of treating them as a $0 balance — a
  // swallowed error here would make an owing patient look paid and could
  // wrongly RESOLVE their dunning run (collection silently stops). Fail the
  // tick and retry rather than act on a phantom zero.
  const { data: claims, error } = await supabase
    .from("insurance_claims")
    .select("patient_responsibility_cents")
    .eq("patient_id", patientId)
    .gt("patient_responsibility_cents", 0)
    .in("status", [...BILLABLE_CLAIM_STATUSES]);
  if (error) throw error;
  return (
    (claims ?? []) as Array<{ patient_responsibility_cents: number }>
  ).reduce((s, c) => s + (c.patient_responsibility_cents ?? 0), 0);
}

async function patientGuards(
  supabase: Supabase,
  patientId: string,
): Promise<{ hasActivePlan: boolean; hasAutopay: boolean }> {
  // Surface read failures: a swallowed error here would report "no active
  // plan / no autopay" and let the engine dun a patient who is actually on a
  // payment plan or autopay. Fail the tick instead.
  const [{ data: plan, error: planErr }, { data: ap, error: apErr }] =
    await Promise.all([
      supabase
        .from("patient_payment_plans")
        .select("id")
        .eq("patient_id", patientId)
        .eq("status", "active")
        .limit(1),
      supabase
        .from("patient_autopay_authorizations")
        .select("autopay_enabled")
        .eq("patient_id", patientId)
        .eq("autopay_enabled", true)
        .limit(1),
    ]);
  if (planErr) throw planErr;
  if (apErr) throw apErr;
  return {
    hasActivePlan: (plan ?? []).length > 0,
    hasAutopay: (ap ?? []).length > 0,
  };
}

export interface OpenScanStats {
  candidates: number;
  opened: number;
}

export async function runDunningOpenScanForOrg(
  orgId: string,
  today: Date = new Date(),
): Promise<OpenScanStats> {
  const stats: OpenScanStats = { candidates: 0, opened: 0 };
  if (!(await isFeatureEnabled("collections.dunning", orgId))) return stats;
  const supabase = getOrgScopedClient(orgId);
  // Practice-local business date, not UTC — the open-scan cron runs in the
  // early-UTC hours (still the prior evening in US timezones), so a UTC date
  // would stamp opened_on a day ahead and shift the whole +7/+21/+35/+60 ladder
  // one calendar day early for US patients.
  const todayIso = practiceTodayIso(today);

  // One set-based query (migration 0462) returns every patient over the floor
  // with no active run / plan / autopay — net balance already computed. Far
  // cheaper than the old per-patient round-trips.
  const { data, error: rpcError } = await supabase
    .raw()
    .schema("resupply")
    .rpc("dunning_candidates", {
      p_org_id: orgId,
      p_min_cents: DUNNING_MIN_BALANCE_CENTS,
    });
  if (rpcError) throw rpcError;
  const candidates = (
    (data ?? []) as Array<{ patient_id: string; balance_cents: number }>
  ).slice(0, MAX_CANDIDATES);

  for (const c of candidates) {
    stats.candidates += 1;
    const { error } = await supabase.from("patient_dunning_runs").insert({
      patient_id: c.patient_id,
      opened_balance_cents: c.balance_cents,
      opened_on: todayIso,
      current_step: "statement",
      next_action_at: today.toISOString(),
      status: "active",
    });
    // A concurrent open or the partial-unique index can reject the second
    // insert — that's fine, the run exists.
    if (!error) stats.opened += 1;
  }
  return stats;
}

export interface TickStats {
  processed: number;
  sent: number;
  resolved: number;
  paused: number;
  handoff: number;
  skipped: number;
}

export async function runDunningTickForOrg(
  orgId: string,
  now: Date = new Date(),
): Promise<TickStats> {
  const stats: TickStats = {
    processed: 0,
    sent: 0,
    resolved: 0,
    paused: 0,
    handoff: 0,
    skipped: 0,
  };
  if (!(await isFeatureEnabled("collections.dunning", orgId))) return stats;
  const supabase = getOrgScopedClient(orgId);
  // Practice-local business date for the ladder decision (see open-scan note).
  const todayIso = practiceTodayIso(now);

  const { data: dueRows, error: dueErr } = await supabase
    .from("patient_dunning_runs")
    .select("id, patient_id, current_step, next_action_at, opened_on")
    .eq("status", "active")
    .lte("next_action_at", now.toISOString())
    .order("next_action_at", { ascending: true })
    .limit(MAX_TICK);
  // Surface the read failure instead of treating an errored fetch as "no due
  // runs" (a silent no-op tick that hides a broken collections loop).
  if (dueErr) throw dueErr;
  const runs = (dueRows ?? []) as Array<{
    id: string;
    patient_id: string;
    current_step: DunningStep;
    next_action_at: string | null;
    opened_on: string;
  }>;
  if (runs.length === 0) return stats;

  // One tenant statement config for the whole batch.
  const cfg = await applyTenantStatementIdentity(
    orgId,
    readStatementMessagingConfig(),
  );

  for (const run of runs) {
    stats.processed += 1;
    const balance = await computeBalanceCents(supabase, run.patient_id);
    const guards = await patientGuards(supabase, run.patient_id);
    const decision = decideDunningAction({
      currentStep: run.current_step,
      nextActionAt: run.next_action_at,
      balanceCents: balance,
      hasActivePaymentPlan: guards.hasActivePlan,
      hasAutopay: guards.hasAutopay,
      today: todayIso,
    });

    if (decision.type === "wait") continue;

    if (decision.type === "resolve") {
      await closeRun(supabase, run.id, "resolved", { resolved_reason: "paid" });
      await logEvent(supabase, run.id, run.current_step, "none", "resolved", {
        balance,
      });
      stats.resolved += 1;
      continue;
    }
    if (decision.type === "pause") {
      await closeRun(supabase, run.id, "paused", {
        paused_reason: decision.reason,
      });
      await logEvent(supabase, run.id, run.current_step, "none", "paused", {
        balance,
        detail: decision.reason,
      });
      stats.paused += 1;
      continue;
    }
    if (decision.type === "handoff") {
      // Park at the agency step for the reviewed export — no auto-send.
      await supabase
        .from("patient_dunning_runs")
        .update({ next_action_at: null, updated_at: now.toISOString() })
        .eq("id", run.id);
      await logEvent(supabase, run.id, "agency", "none", "handoff", {
        balance,
      });
      stats.handoff += 1;
      continue;
    }

    // decision.type === "send" — choose a consent-safe channel and deliver.
    const { data: patient, error: patientErr } = await supabase
      .from("patients")
      .select("email, phone_e164, communication_preferences")
      .eq("id", run.patient_id)
      .limit(1)
      .maybeSingle();
    // Don't let a transient read error masquerade as "patient has no contact
    // info" (which would wrongly skip the dunning send). Fail the tick.
    if (patientErr) throw patientErr;
    const prefs = readStatementPrefs(
      (patient?.communication_preferences ?? null) as never,
    );
    const pick = pickStatementChannel(
      prefs,
      { hasEmail: !!patient?.email, hasPhone: !!patient?.phone_e164 },
      now,
    );
    if (!pick.channel) {
      await logEvent(supabase, run.id, run.current_step, "none", "skipped", {
        balance,
        detail: pick.reason,
      });
      stats.skipped += 1;
      // Still advance the ladder so a perpetually-unreachable patient doesn't
      // wedge the run at one step forever.
      await advance(supabase, run, now);
      continue;
    }
    const outcome = await sendStatementMessage(
      {
        statementId: run.id,
        amountCents: balance,
        email: patient?.email ?? null,
        phoneE164: patient?.phone_e164 ?? null,
        pdfUrl: null,
      },
      pick.channel,
      cfg,
    );
    if (outcome.kind === "sent") {
      await logEvent(supabase, run.id, run.current_step, pick.channel, "sent", {
        balance,
      });
      stats.sent += 1;
    } else {
      await logEvent(
        supabase,
        run.id,
        run.current_step,
        pick.channel,
        "failed",
        { balance, detail: "reason" in outcome ? outcome.reason : undefined },
      );
      stats.skipped += 1;
    }
    await advance(supabase, run, now);
  }
  return stats;
}

async function advance(
  supabase: Supabase,
  run: { id: string; current_step: DunningStep; opened_on: string },
  now: Date,
): Promise<void> {
  const next = nextDunningStep(run.current_step, run.opened_on);
  if (!next) return;
  await supabase
    .from("patient_dunning_runs")
    .update({
      current_step: next.step,
      next_action_at: `${next.nextActionAt}T00:00:00Z`,
      last_step_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("id", run.id);
}

async function closeRun(
  supabase: Supabase,
  runId: string,
  status: "resolved" | "paused",
  extra: { resolved_reason?: string; paused_reason?: string },
): Promise<void> {
  await supabase
    .from("patient_dunning_runs")
    .update({
      status,
      next_action_at: null,
      updated_at: new Date().toISOString(),
      ...extra,
    })
    .eq("id", runId);
}

async function logEvent(
  supabase: Supabase,
  runId: string,
  step: string,
  channel: "email" | "sms" | "letter" | "none",
  outcome: "sent" | "skipped" | "failed" | "paused" | "resolved" | "handoff",
  opts: { balance?: number; detail?: string } = {},
): Promise<void> {
  await supabase.from("patient_dunning_events").insert({
    run_id: runId,
    step,
    channel,
    outcome,
    detail: opts.detail ?? null,
    amount_at_touch_cents: opts.balance ?? null,
  });
}

export async function runDunningOpenScan(
  today: Date = new Date(),
): Promise<OpenScanStats> {
  const stats: OpenScanStats = { candidates: 0, opened: 0 };
  await forEachActiveOrg(
    async (orgId) => {
      const s = await runDunningOpenScanForOrg(orgId, today);
      stats.candidates += s.candidates;
      stats.opened += s.opened;
    },
    { jobName: OPEN_SCAN_JOB },
  );
  return stats;
}

export async function runDunningTick(
  now: Date = new Date(),
): Promise<TickStats> {
  const stats: TickStats = {
    processed: 0,
    sent: 0,
    resolved: 0,
    paused: 0,
    handoff: 0,
    skipped: 0,
  };
  await forEachActiveOrg(
    async (orgId) => {
      const s = await runDunningTickForOrg(orgId, now);
      stats.processed += s.processed;
      stats.sent += s.sent;
      stats.resolved += s.resolved;
      stats.paused += s.paused;
      stats.handoff += s.handoff;
      stats.skipped += s.skipped;
    },
    { jobName: TICK_JOB },
  );
  return stats;
}

export async function registerDunningOpenScanJob(boss: PgBoss): Promise<void> {
  await createQueueWithDlq(boss, OPEN_SCAN_JOB, CRON_SCAN_QUEUE_OPTS);
  await boss.work(OPEN_SCAN_JOB, async () => {
    try {
      const stats = await runDunningOpenScan();
      logger.info(
        { event: "collections.dunning-open-scan.completed", ...stats },
        "collections.dunning-open-scan: completed",
      );
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        "collections.dunning-open-scan: failed",
      );
      throw err;
    }
  });
  await boss.schedule(OPEN_SCAN_JOB, OPEN_SCAN_CRON);
  logger.info(
    { cron: OPEN_SCAN_CRON },
    "collections.dunning-open-scan scheduled",
  );
}

export async function registerDunningTickJob(boss: PgBoss): Promise<void> {
  await createQueueWithDlq(boss, TICK_JOB, CRON_SCAN_QUEUE_OPTS);
  await boss.work(TICK_JOB, async () => {
    try {
      const stats = await runDunningTick();
      logger.info(
        { event: "collections.dunning-tick.completed", ...stats },
        "collections.dunning-tick: completed",
      );
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        "collections.dunning-tick: failed",
      );
      throw err;
    }
  });
  await boss.schedule(TICK_JOB, TICK_CRON);
  logger.info({ cron: TICK_CRON }, "collections.dunning-tick scheduled");
}

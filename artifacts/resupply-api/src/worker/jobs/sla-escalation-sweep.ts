// pg-boss job: sweep conversations that have breached their SLA and
// flag them escalated so they surface in the inbox "escalated" view.
//
// Why this exists:
//   The conversations inbox already has a "breaching" view (sla_due_at
//   within 30 min) and an "escalated" view (escalated_at IS NOT NULL),
//   but nothing MOVES a thread from breaching → escalated on its own. A
//   CSR who isn't watching the breaching filter never sees a thread go
//   past its SLA; it just sits in the default queue. This job closes
//   that gap: once a thread is actually past its SLA deadline it gets
//   stamped escalated_at + escalation_reason='sla_breached', which the
//   existing "escalated" inbox bucket (routes/conversations/list.ts:124,
//   `.not("escalated_at","is",null)`) sorts to the top automatically —
//   no new UI and no schema change needed.
//
// What it does NOT do: it does not message the patient and does not
// reassign. It is a pure internal visibility flag, so it is safe to run
// unattended once enabled. (csr_compliance_alerts is intentionally NOT
// written — its alert_type is a fixed enum without an SLA value and its
// patient_id is NOT NULL, so the escalated_at flag is the right, schema-
// stable surfacing mechanism.)
//
// Scheduling: OPT-IN. The queue + worker always register (so an admin
// "Run now" trigger could call the run core), but the recurring schedule
// only attaches when RESUPPLY_SLA_ESCALATION_CRON is set to a 5-field
// cron expression — same conservative posture as the clinical-outreach
// and eligibility batches. A reasonable value is "*/15 * * * *".
//
// Idempotency: the scan filters escalated_at IS NULL, so an already-
// escalated thread is never re-touched. The per-row update re-checks the
// null guard to tolerate a concurrent manual escalation.

import type PgBoss from "pg-boss";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { createQueueWithDlq, CRON_SCAN_QUEUE_OPTS } from "../lib/queue-options";

const SWEEP_JOB = "conversations.sla-escalation-sweep";

// Statuses that still belong in a CSR queue. A closed/terminal thread
// past its SLA needs no escalation.
const ACTIVE_STATUSES = ["open", "awaiting_admin"] as const;

const SWEEP_PAGE_SIZE = 200;
const MAX_PER_TICK = 5_000;

// Minutes past the deadline at which an escalation is "critical" rather
// than "warning". Urgent-priority threads are critical the moment they
// breach.
const CRITICAL_OVERDUE_MINUTES = 60;

interface SweepStats {
  scanned: number;
  escalated: number;
  warning: number;
  critical: number;
}

export interface SlaConversationRow {
  id: string;
  patient_id: string | null;
  customer_id: string | null;
  status: string;
  priority: string | null;
  sla_due_at: string | null;
  escalated_at: string | null;
}

export interface SlaEscalationPlan {
  conversationId: string;
  patientId: string | null;
  customerId: string | null;
  minutesOverdue: number;
  severity: "warning" | "critical";
}

/**
 * Pure: from a page of candidate conversations, select the ones actually
 * past their SLA deadline (and not already escalated) and assign each a
 * severity. No I/O — unit-tested directly. The DB query pre-filters too,
 * but re-deriving here keeps the severity logic testable and guards
 * against a row that slipped in with a future/blank deadline.
 */
export function planSlaEscalations(
  rows: readonly SlaConversationRow[],
  nowMs: number,
): SlaEscalationPlan[] {
  const out: SlaEscalationPlan[] = [];
  for (const r of rows) {
    if (r.escalated_at) continue;
    if (!r.sla_due_at) continue;
    const due = Date.parse(r.sla_due_at);
    if (Number.isNaN(due) || due > nowMs) continue; // not yet breached
    const minutesOverdue = Math.floor((nowMs - due) / 60_000);
    const severity: "warning" | "critical" =
      r.priority === "urgent" || minutesOverdue >= CRITICAL_OVERDUE_MINUTES
        ? "critical"
        : "warning";
    out.push({
      conversationId: r.id,
      patientId: r.patient_id ?? null,
      customerId: r.customer_id ?? null,
      minutesOverdue,
      severity,
    });
  }
  return out;
}

/** Exported for test injection. One sweep cycle; returns counts. */
export async function runSlaEscalationSweep(): Promise<SweepStats> {
  const supabase = getSupabaseServiceRoleClient();
  const stats: SweepStats = {
    scanned: 0,
    escalated: 0,
    warning: 0,
    critical: 0,
  };
  let lastId: string | null = null;

  while (stats.escalated < MAX_PER_TICK) {
    const nowIso = new Date().toISOString();
    const pageQuery = supabase
      .schema("resupply")
      .from("conversations")
      .select(
        "id, patient_id, customer_id, status, priority, sla_due_at, escalated_at",
      )
      .is("escalated_at", null)
      .not("sla_due_at", "is", null)
      .lte("sla_due_at", nowIso)
      .in("status", ACTIVE_STATUSES as unknown as string[])
      .order("id", { ascending: true })
      .limit(SWEEP_PAGE_SIZE);
    const pageResult = await (lastId ? pageQuery.gt("id", lastId) : pageQuery);
    if (pageResult.error) throw pageResult.error;
    const rows = (pageResult.data ?? []) as SlaConversationRow[];
    if (rows.length === 0) break;
    stats.scanned += rows.length;
    lastId = rows[rows.length - 1]?.id ?? lastId;

    const plans = planSlaEscalations(rows, Date.now());
    for (const plan of plans) {
      const { data: updated, error: updErr } = await supabase
        .schema("resupply")
        .from("conversations")
        .update({
          escalated_at: new Date().toISOString(),
          escalation_reason: "sla_breached",
          updated_at: new Date().toISOString(),
        })
        .eq("id", plan.conversationId)
        // Re-check the null guard so a concurrent manual escalation isn't
        // clobbered (PostgREST has no row lock; eq/is is the cheap guard).
        .is("escalated_at", null)
        .select("id");
      if (updErr) throw updErr;
      if (!updated || updated.length === 0) continue; // raced — already escalated
      stats.escalated += 1;
      if (plan.severity === "critical") stats.critical += 1;
      else stats.warning += 1;
      if (stats.escalated >= MAX_PER_TICK) break;
    }

    if (rows.length < SWEEP_PAGE_SIZE) break;
  }

  return stats;
}

export async function registerSlaEscalationSweepJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(boss, SWEEP_JOB, CRON_SCAN_QUEUE_OPTS);

  await boss.work(SWEEP_JOB, async () => {
    try {
      const stats = await runSlaEscalationSweep();
      logger.info(
        { event: "sla-escalation-sweep.completed", ...stats },
        "sla-escalation-sweep: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "sla-escalation-sweep: failed",
      );
      throw err;
    }
  });

  const cron = process.env.RESUPPLY_SLA_ESCALATION_CRON?.trim();
  if (cron) {
    await boss.schedule(SWEEP_JOB, cron);
    logger.info({ queue: SWEEP_JOB, cron }, "sla-escalation-sweep scheduled");
  } else {
    // boss.schedule() persists the cron in pg-boss; merely not
    // re-scheduling does NOT stop a previously-attached schedule.
    // Clear any stale row so removing the env var actually turns
    // the cron off (same pattern as worker/lib/table-guard.ts).
    // typeof-guarded like worker/lib/table-guard.ts — test
    // doubles (and old pg-boss) may not implement unschedule.
    if (typeof boss.unschedule === "function") {
      await boss.unschedule(SWEEP_JOB).catch(() => undefined);
    }
    logger.info(
      { queue: SWEEP_JOB },
      "sla-escalation-sweep registered (cron opt-in unset; manual-trigger only)",
    );
  }
}

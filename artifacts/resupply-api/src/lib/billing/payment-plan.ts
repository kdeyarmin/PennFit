// Patient payment-plan math (biller #B7). Pure + I/O-free: installment
// schedule generation, plan-status derivation, and an A/R summary. Money
// movement (Stripe auto-charge) is intentionally NOT here — this slice
// is the schedule + tracking the biller/CSR uses to manage a patient
// balance paid over time; charging is a follow-up. Unit-tested directly.

export type PlanFrequency = "weekly" | "biweekly" | "monthly";

export interface ScheduledInstallment {
  seq: number;
  /** YYYY-MM-DD. */
  dueDate: string;
  amountCents: number;
}

function isoFromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Nth due date from `startIso` for the given cadence. Pure, UTC. */
function addInterval(startIso: string, freq: PlanFrequency, n: number): string {
  const [y, m, d] = startIso.split("-").map(Number);
  if (!y || !m || !d) return startIso;
  if (freq === "monthly") {
    const base = new Date(Date.UTC(y, m - 1, 1));
    base.setUTCMonth(base.getUTCMonth() + n);
    const year = base.getUTCFullYear();
    const month = base.getUTCMonth();
    // Clamp to the month's last day so Jan-31 + 1mo → Feb-28/29, not Mar-03.
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return isoFromUtc(Date.UTC(year, month, Math.min(d, lastDay)));
  }
  const days = (freq === "weekly" ? 7 : 14) * n;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Split `totalAmountCents` into `installmentCount` installments on the
 * given cadence. The integer-division remainder is added to the FIRST
 * installment so the schedule always sums EXACTLY to the total (no lost
 * or phantom cents). Pure.
 */
export function generateInstallmentSchedule(input: {
  totalAmountCents: number;
  installmentCount: number;
  frequency: PlanFrequency;
  startDate: string;
}): ScheduledInstallment[] {
  const { totalAmountCents, installmentCount, frequency, startDate } = input;
  const base = Math.floor(totalAmountCents / installmentCount);
  const remainder = totalAmountCents - base * installmentCount;
  const out: ScheduledInstallment[] = [];
  for (let i = 0; i < installmentCount; i++) {
    out.push({
      seq: i + 1,
      dueDate: addInterval(startDate, frequency, i),
      amountCents: base + (i === 0 ? remainder : 0),
    });
  }
  return out;
}

export type InstallmentStatus = "scheduled" | "paid" | "overdue" | "waived";

export interface InstallmentRow {
  amountCents: number;
  status: InstallmentStatus;
  dueDate: string;
}

export interface PlanSummary {
  paidCents: number;
  /** Still owed = scheduled + overdue installments. */
  remainingCents: number;
  overdueCount: number;
  overdueCents: number;
  nextDueDate: string | null;
}

/** A/R rollup for one plan as of `todayIso`. Pure. */
export function computePlanSummary(
  installments: readonly InstallmentRow[],
  todayIso: string,
): PlanSummary {
  let paidCents = 0;
  let remainingCents = 0;
  let overdueCount = 0;
  let overdueCents = 0;
  let nextDueDate: string | null = null;
  for (const i of installments) {
    if (i.status === "paid") {
      paidCents += i.amountCents;
      continue;
    }
    if (i.status === "waived") continue;
    // scheduled / overdue → still owed
    remainingCents += i.amountCents;
    const isOverdue = i.dueDate < todayIso;
    if (isOverdue) {
      overdueCount += 1;
      overdueCents += i.amountCents;
    }
    if (nextDueDate === null || i.dueDate < nextDueDate) {
      nextDueDate = i.dueDate;
    }
  }
  return { paidCents, remainingCents, overdueCount, overdueCents, nextDueDate };
}

/**
 * Derive the plan's lifecycle status from its installments: `completed`
 * once every installment is paid or waived, else `active`. (A manually
 * cancelled plan is handled by the caller and never passed here.) Pure.
 */
export function derivePlanStatus(
  installments: readonly InstallmentRow[],
): "active" | "completed" {
  if (installments.length === 0) return "active";
  const allSettled = installments.every(
    (i) => i.status === "paid" || i.status === "waived",
  );
  return allSettled ? "completed" : "active";
}

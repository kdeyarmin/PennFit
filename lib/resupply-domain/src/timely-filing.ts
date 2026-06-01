// Timely-filing countdown — pure value-object logic (ADR 008: no I/O).
//
// Every payer enforces a "timely filing" window: a claim must be
// submitted within N calendar days of the date of service or it's
// auto-denied with no appeal. The per-payer window lives in
// payer_profiles.timely_filing_days (migration 0142). This is the shared
// core that turns (date of service, window) into a countdown + a status,
// so the billing surfaces (a "filing deadline" column / worklist) all
// compute it one tested way (Biller #36).
//
// Unknown window (payer not configured) or an unparseable date of
// service → status "unknown" with null countdown, never a fabricated
// deadline — the same honesty posture as the cost layer's unknown cost.

export type TimelyFilingStatus = "ok" | "due_soon" | "overdue" | "unknown";

export interface TimelyFilingInput {
  /** Date of service (ISO date or datetime). */
  dateOfService: string;
  /** Per-payer window in calendar days (payer_profiles.timely_filing_days).
   *  null/undefined/<=0 → unknown. */
  filingWindowDays: number | null | undefined;
  /** "Now" for the countdown; defaults to the current time. */
  asOf?: string;
  /** Days-remaining at or below which status becomes "due_soon". Default 14. */
  dueSoonThresholdDays?: number;
}

export interface TimelyFilingResult {
  status: TimelyFilingStatus;
  /** Whole days until the deadline; negative = past due. null when unknown. */
  daysRemaining: number | null;
  /** The filing deadline (date of service + window) as YYYY-MM-DD, or null. */
  deadline: string | null;
}

const DAY_MS = 86_400_000;

export function timelyFilingStatus(
  input: TimelyFilingInput,
): TimelyFilingResult {
  const unknown: TimelyFilingResult = {
    status: "unknown",
    daysRemaining: null,
    deadline: null,
  };

  const window = input.filingWindowDays;
  if (window == null || !Number.isFinite(window) || window <= 0) return unknown;

  // Compute on whole calendar days: truncate both the date of service
  // and "now" to their UTC date, so the deadline DAY itself reads as
  // 0 days remaining (due_soon), not −1 (overdue), regardless of the
  // time of day.
  const dosDateMs = Date.parse(input.dateOfService.slice(0, 10));
  if (Number.isNaN(dosDateMs)) return unknown;

  const asOfParsed = input.asOf ? Date.parse(input.asOf) : Date.now();
  const asOfMs = Number.isNaN(asOfParsed) ? Date.now() : asOfParsed;
  const asOfDateMs = Date.parse(new Date(asOfMs).toISOString().slice(0, 10));

  const deadlineMs = dosDateMs + Math.trunc(window) * DAY_MS;
  const deadline = new Date(deadlineMs).toISOString().slice(0, 10);
  const daysRemaining = Math.round((deadlineMs - asOfDateMs) / DAY_MS);

  const dueSoon = input.dueSoonThresholdDays ?? 14;
  let status: TimelyFilingStatus;
  if (daysRemaining < 0) status = "overdue";
  else if (daysRemaining <= dueSoon) status = "due_soon";
  else status = "ok";

  return { status, daysRemaining, deadline };
}

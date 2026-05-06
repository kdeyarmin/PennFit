export type LifecycleStatus =
  | "eligible"
  | "notified"
  | "engaged"
  | "checkout_started"
  | "reordered"
  | "dropped"
  | "suppressed";

export type ReminderSuppressionReason =
  | "invalid_baseline_date"
  | "missing_baseline_date"
  | "channel_daily_cap"
  | "cooldown_window"
  | "duplicate_send";

export interface LifecycleOutcome {
  patientId: string;
  status: LifecycleStatus;
  reason?: ReminderSuppressionReason | "price_unavailable" | "session_expired";
  occurredAt: string;
}

export function toLifecycleOutcome(
  patientId: string,
  status: LifecycleStatus,
  reason?: LifecycleOutcome["reason"],
): LifecycleOutcome {
  return { patientId, status, reason, occurredAt: new Date().toISOString() };
}

// Automated `low_usage_checkin` alert trigger.
//
// Fired (fire-and-forget) from the daily compliance scanner
// (lib/compliance-scanner.ts) when it opens a NEW `low_usage`
// csr_compliance_alerts row for a patient — i.e. the patient's therapy
// adherence just dropped below the per-window target. Today that scan
// only creates a STAFF-facing CSR alert; this adds an optional
// PATIENT-facing nudge ("we noticed your usage dropped, here's how to
// get help"), gated by the `alerts.auto_dispatch` feature flag.
//
// Why only on a NEW alert (not every scan):
//   The scanner runs daily and refreshes the open alert each day the
//   patient stays below target. We fire the patient message only when
//   the alert is first opened, so the patient gets one check-in — not a
//   daily guilt-trip. The caller passes `isNewAlert`.
//
// Why skip when the coach phone is unset:
//   The low_usage_checkin copy references {{coach_phone}}. With it
//   unset, dispatchAlert's unresolved-token guard would refuse the
//   send anyway — we short-circuit earlier with a clear log so the
//   "why isn't this sending?" answer is obvious to operators.
//
// Fail-closed: the flag defaults OFF and every unresolved step logs +
// returns. Never throws — safe to call without awaiting.

import { isFeatureEnabled } from "../feature-flags";
import { logger } from "../logger";
import { dispatchAlert } from "./dispatch";

export interface LowUsageCheckinTriggerInput {
  patientId: string;
  /**
   * Count of "good" nights (>=4h usage) so far in the program. Used as
   * the {{nights_used}} variable. It's cumulative-since-journey-start,
   * not a trailing window — fine for a soft nudge, not a clinical stat.
   */
  nightsUsed: number;
}

export async function maybeDispatchLowUsageCheckinAlert(
  input: LowUsageCheckinTriggerInput,
): Promise<void> {
  const { patientId, nightsUsed } = input;
  try {
    // Fail-closed flag gate — inert until an operator turns it on.
    if (!(await isFeatureEnabled("alerts.auto_dispatch"))) return;

    const coachPhone = process.env.RESUPPLY_COACH_PHONE?.trim();
    if (!coachPhone) {
      logger.info(
        { event: "low_usage_checkin_skipped", reason: "no_coach_phone" },
        "alerts: low_usage_checkin trigger — RESUPPLY_COACH_PHONE unset; skipping",
      );
      return;
    }

    const outcome = await dispatchAlert({
      alertKey: "low_usage_checkin",
      channel: "email",
      patientId,
      variables: {
        nights_used: String(nightsUsed),
        coach_phone: coachPhone,
      },
    });

    logger.info(
      {
        event: "low_usage_checkin_dispatched",
        outcome: outcome.status,
        patient_id: patientId,
      },
      "alerts: low_usage_checkin trigger — dispatch complete",
    );
  } catch (err) {
    logger.warn(
      {
        event: "low_usage_checkin_error",
        patient_id: patientId,
        err,
      },
      "alerts: low_usage_checkin trigger failed (non-fatal)",
    );
  }
}

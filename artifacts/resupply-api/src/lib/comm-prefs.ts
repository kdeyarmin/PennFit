// Helpers for evaluating per-customer communication preferences in
// dispatchers (cart abandonment, order tracking, review request, etc).
//
// These are PURE functions over a CommunicationPreferences object so
// dispatchers can batch-fetch the rows themselves and decide locally.
//
// DND evaluation is timezone-aware. We use Intl.DateTimeFormat to map
// the current UTC instant into the customer's local hour, then check
// against [dndStartHour, dndEndHour). Windows that wrap midnight
// (start=22, end=7) are handled correctly.

import type { CommunicationPreferences } from "@workspace/resupply-db";

import { inferTimezoneFromZip } from "./zip-timezone";

/**
 * Resolve the effective timezone for DND evaluation. Order of
 * precedence:
 *
 *   1. prefs.timezone — the customer's explicit preference if set.
 *   2. shippingZip   — inferred from the shipping address ZIP.
 *   3. null          — caller defaults to UTC.
 *
 * Pure function; safe to call repeatedly.
 */
export function resolveTimezone(
  prefs: CommunicationPreferences,
  shippingZip?: string | null,
): string | null {
  if (prefs.timezone) return prefs.timezone;
  if (shippingZip) return inferTimezoneFromZip(shippingZip);
  return null;
}

export interface DndOptions {
  /**
   * Optional 5-digit US shipping ZIP. When set and prefs.timezone is
   * null, we infer the timezone from the ZIP — fixes the
   * "patient never set a tz" case where DND used to silently
   * evaluate against UTC and text every patient at 4am local.
   */
  shippingZip?: string | null;
}

export function isInDndWindow(
  prefs: CommunicationPreferences,
  now: Date = new Date(),
  opts: DndOptions = {},
): boolean {
  if (prefs.dndStartHour === null || prefs.dndEndHour === null) return false;
  const tz = resolveTimezone(prefs, opts.shippingZip);
  let localHour: number;
  try {
    if (tz) {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "numeric",
        hour12: false,
      });
      const parts = fmt.formatToParts(now);
      const hourPart = parts.find((p) => p.type === "hour")?.value;
      localHour = hourPart ? Number(hourPart) % 24 : now.getUTCHours();
    } else {
      // No timezone configured AND no shipping ZIP to infer from —
      // fall back to UTC. Better than refusing to send (which would
      // silently drop nudges for every account without a tz).
      localHour = now.getUTCHours();
    }
  } catch {
    return false;
  }
  if (prefs.dndStartHour < prefs.dndEndHour) {
    // Same-day window, e.g. 13–17.
    return localHour >= prefs.dndStartHour && localHour < prefs.dndEndHour;
  }
  // Wrap-midnight window, e.g. 22–07.
  return localHour >= prefs.dndStartHour || localHour < prefs.dndEndHour;
}

/**
 * Hard TCPA send-window gate for automated SMS — independent of the
 * user-configurable DND window above, whose null default protects
 * nobody who hasn't configured it. TCPA's legal window for automated
 * texts is 8am–9pm local to the recipient; internal policy is the
 * narrower 9am–8pm (half-open: 9 <= hour < 20 allowed). This mirrors
 * the gate the reminders scan has always applied, lifted here so every
 * SMS-dispatching job shares it (app-review 2026-06-10, P1-3).
 *
 * Timezone resolution: explicit patient/pref timezone → ZIP inference
 * → America/New_York (the practice's home timezone and the
 * conservative default for an Eastern-US patient base). An
 * unrecognized tz string also falls back to ET.
 *
 * NOTE for daily cron callers: a fixed-UTC daily job that gate-skips a
 * patient will land on the same local hour tomorrow and skip them
 * again, forever. Pair this gate with a cron hour that is inside
 * 9am–8pm for every US timezone (≈ 19:00–20:00 UTC) — the gate is the
 * backstop, not the schedule.
 */
export const SMS_SEND_WINDOW_START_HOUR = 9;
export const SMS_SEND_WINDOW_END_HOUR = 20;

export interface SmsSendWindowOptions {
  /** IANA timezone (e.g. patients.timezone / prefs.timezone). */
  timezone?: string | null;
  /** 5-digit US ZIP for inference when no explicit timezone is set. */
  shippingZip?: string | null;
}

export function isOutsideSmsSendWindow(
  now: Date = new Date(),
  opts: SmsSendWindowOptions = {},
): boolean {
  const tz =
    opts.timezone ??
    (opts.shippingZip ? inferTimezoneFromZip(opts.shippingZip) : null) ??
    "America/New_York";
  const localHour = (timeZone: string): number => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hour12: false,
    }).formatToParts(now);
    const hour = Number.parseInt(
      parts.find((p) => p.type === "hour")?.value ?? "",
      10,
    );
    if (!Number.isFinite(hour)) throw new Error("non-numeric hour");
    // Some ICU versions render midnight as "24" under hour12:false.
    return hour % 24;
  };
  let hour: number;
  try {
    hour = localHour(tz);
  } catch {
    hour = localHour("America/New_York");
  }
  return hour < SMS_SEND_WINDOW_START_HOUR || hour >= SMS_SEND_WINDOW_END_HOUR;
}

export function shouldSendEmail(
  prefs: CommunicationPreferences,
  kind:
    | "marketing"
    | "abandonedCart"
    | "resupplyReminder"
    | "reviewRequest"
    | "billingStatement",
  now: Date = new Date(),
  opts: DndOptions = {},
): boolean {
  if (isInDndWindow(prefs, now, opts)) return false;
  switch (kind) {
    case "marketing":
      return prefs.emailMarketing;
    case "abandonedCart":
      return prefs.emailAbandonedCart;
    case "resupplyReminder":
      return prefs.emailResupplyReminders;
    case "reviewRequest":
      return prefs.emailReviewRequests;
    case "billingStatement":
      return prefs.emailBillingStatements;
  }
}

export function shouldSendSms(
  prefs: CommunicationPreferences,
  kind: "marketing" | "transactional",
  now: Date = new Date(),
  opts: DndOptions = {},
): boolean {
  if (isInDndWindow(prefs, now, opts)) return false;
  switch (kind) {
    case "marketing":
      return prefs.smsMarketing;
    case "transactional":
      return prefs.smsTransactional;
  }
}

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

export function isInDndWindow(
  prefs: CommunicationPreferences,
  now: Date = new Date(),
): boolean {
  if (prefs.dndStartHour === null || prefs.dndEndHour === null) return false;
  const tz = prefs.timezone;
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
      // No timezone configured — fall back to UTC. Better than refusing
      // to send (which would silently drop cart-abandonment nudges for
      // every account that hasn't set a tz).
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

export function shouldSendEmail(
  prefs: CommunicationPreferences,
  kind: "marketing" | "abandonedCart" | "resupplyReminder" | "reviewRequest",
  now: Date = new Date(),
): boolean {
  if (isInDndWindow(prefs, now)) return false;
  switch (kind) {
    case "marketing":
      return prefs.emailMarketing;
    case "abandonedCart":
      return prefs.emailAbandonedCart;
    case "resupplyReminder":
      return prefs.emailResupplyReminders;
    case "reviewRequest":
      return prefs.emailReviewRequests;
  }
}

export function shouldSendSms(
  prefs: CommunicationPreferences,
  kind: "marketing" | "transactional",
  now: Date = new Date(),
): boolean {
  if (isInDndWindow(prefs, now)) return false;
  switch (kind) {
    case "marketing":
      return prefs.smsMarketing;
    case "transactional":
      return prefs.smsTransactional;
  }
}

// Pure rules for the setup chase. Stamps are spent only after a
// channel actually sends, and a replacement signature link starts
// over instead of inheriting the previous order's reminders.

import type { CommunicationPreferences } from "@workspace/resupply-db";

import {
  isInDndWindow,
  isOutsideSmsSendWindow,
  shouldSendEmail,
  shouldSendSms,
} from "../comm-prefs";

const HOUR = 60 * 60 * 1000;

export const EXPIRED_LINK_FOLLOW_UP =
  "The signature link for this new CPAP setup expired. Send a new link from Signature orders.";

export function dueSignatureReminder(input: {
  sentAt: string;
  now: Date;
  reminder24At: string | null;
  reminder48At: string | null;
}): 24 | 48 | null {
  const age = input.now.getTime() - Date.parse(input.sentAt);
  if (!Number.isFinite(age)) return null;
  if (age >= 48 * HOUR && input.reminder24At && !input.reminder48At) return 48;
  if (age >= 24 * HOUR && !input.reminder24At) return 24;
  return null;
}

export function signatureLinkExpired(
  expiresAt: string | null,
  now: Date,
): boolean {
  if (!expiresAt) return false;
  const expires = Date.parse(expiresAt);
  return Number.isFinite(expires) && expires <= now.getTime();
}

export function reminderTargetChanged(input: {
  reminderOrderId: string | null;
  reminderLinkVersion: number | null;
  orderId: string;
  linkVersion: number;
}): boolean {
  return (
    input.reminderOrderId !== input.orderId ||
    input.reminderLinkVersion !== input.linkVersion
  );
}

export interface SignatureChannelDecision {
  allowEmail: boolean;
  allowSms: boolean;
  /** Nothing can go out, and the reason may clear on a later tick. */
  defer: boolean;
}

/**
 * Email uses the resupply-reminder preference, which defaults on.
 * SMS uses the transactional preference when one is stored (default
 * off, and that refusal is honored). With no stored preference, a
 * phone on the signature order is the staff choice to text, still
 * inside the quiet-hours window. A failed preference lookup sends
 * nothing and leaves the stamp unspent.
 */
export function decideSignatureChannels(input: {
  email: string | null;
  phone: string | null;
  explicit: boolean;
  unknown: boolean;
  prefs: CommunicationPreferences;
  now: Date;
  patientTimezone: string | null;
}): SignatureChannelDecision {
  if (input.unknown) {
    return { allowEmail: false, allowSms: false, defer: true };
  }
  const dnd = isInDndWindow(input.prefs, input.now);
  const allowEmail =
    Boolean(input.email) &&
    shouldSendEmail(input.prefs, "resupplyReminder", input.now);
  const smsConsented = input.explicit
    ? shouldSendSms(input.prefs, "transactional", input.now)
    : Boolean(input.phone);
  let allowSms = false;
  let smsWaiting = false;
  if (input.phone && smsConsented) {
    const outside = isOutsideSmsSendWindow(input.now, {
      timezone: input.prefs.timezone ?? input.patientTimezone,
    });
    allowSms = !dnd && !outside;
    smsWaiting = !allowSms;
  } else if (input.phone && input.explicit && dnd) {
    smsWaiting = true;
  }
  const emailWaiting = Boolean(input.email) && !allowEmail && dnd;
  return {
    allowEmail,
    allowSms,
    defer: !allowEmail && !allowSms && (smsWaiting || emailWaiting),
  };
}

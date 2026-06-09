// Pure TypeScript types and constants re-exported by the
// `@workspace/resupply-db` package barrel.
//
// History: these types used to be generated into individual schema
// files under `./schema/**`. That codegen was retired and the
// schema directory was deleted; this module is now the only home
// for the public DB-level types.
//
// Adding a new type to the public surface:
//   1. Declare it here.
//   2. It's automatically re-exported by `./index.ts`'s
//      `export * from "./types"`.

// ────────────────────────────────────────────────────────────────
// Admin / staff roles
// ────────────────────────────────────────────────────────────────

/**
 * Roles persisted in `resupply.admin_users.role`. The set is the
 * pre-Phase-B legacy enum kept on the DB column for backward
 * compatibility; at lookup time the role normalizes through
 * `toEffectiveRole(...)` in `lib/resupply-auth/src/rbac.ts` into the
 * three product-facing buckets (super_admin / admin /
 * customer_service_rep).
 */
export type AdminRole =
  | "admin"
  | "supervisor"
  | "csr"
  | "fitter"
  | "fulfillment"
  | "compliance_officer"
  | "agent"
  | "rt";

export type AdminStatus = "pending" | "active" | "revoked";

// ────────────────────────────────────────────────────────────────
// In-house auth (auth.users)
// ────────────────────────────────────────────────────────────────

export type AuthRole = "customer" | "agent" | "admin";

export type AuthUserStatus = "active" | "invited" | "locked" | "revoked";

/** Purpose of a single-use email-delivered token (auth.email_tokens). */
export type EmailTokenPurpose =
  | "signup_verify"
  | "password_reset"
  | "email_change";

// ────────────────────────────────────────────────────────────────
// Patient onboarding cadence (resupply.patient_onboarding_journeys)
// ────────────────────────────────────────────────────────────────

/**
 * Day-offset labels the dispatcher uses to schedule patient
 * adherence-coaching nudges. `day1` is legacy (pre-0065); new code
 * only schedules day3 / day7 / day30 / day60 / day90.
 */
export type OnboardingDayLabel =
  | "day1"
  | "day3"
  | "day7"
  | "day30"
  | "day60"
  | "day90";

/**
 * Day labels in send-order, with their offset-from-anchor in days.
 * Imported by the dispatcher to compute the next-due check-in given
 * a row's per-day timestamps. The legacy `day1` slot is absent —
 * the new cadence shifts the first nudge to day-3 (peak
 * mask-discomfort window).
 */
export const ONBOARDING_DAYS: ReadonlyArray<{
  label: OnboardingDayLabel;
  offsetDays: number;
}> = [
  { label: "day3", offsetDays: 3 },
  { label: "day7", offsetDays: 7 },
  { label: "day30", offsetDays: 30 },
  { label: "day60", offsetDays: 60 },
  { label: "day90", offsetDays: 90 },
];

// ────────────────────────────────────────────────────────────────
// Therapy-cloud sources (resupply.patient_therapy_nights.source)
// ────────────────────────────────────────────────────────────────

export type TherapyCloudSource =
  | "resmed_airview"
  | "philips_care"
  | "react_health"
  | "manual";

// ────────────────────────────────────────────────────────────────
// Shop customer JSONB shapes (resupply.shop_customers)
// ────────────────────────────────────────────────────────────────

/**
 * Saved shipping address shape. Stored as JSONB so we can evolve
 * the field set (e.g. add country) without a migration. The PUT
 * /shop/me route validates this with Zod before persisting.
 */
export interface SavedShippingAddress {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: "US";
}

/**
 * Per-customer communication preferences for the cash-pay shop.
 * Every flag is opt-OUT (defaults to true on first account hit) for
 * the transactional channels and opt-IN (defaults to false) for the
 * marketing-style channels. Dispatchers consult this object before
 * sending — see the abandonment-cart and order-tracking helpers.
 */
export interface CommunicationPreferences {
  /** Marketing emails (new product announcements, promotions). */
  emailMarketing: boolean;
  /** Resupply / restock reminder emails. */
  emailResupplyReminders: boolean;
  /** Cart-abandonment recovery emails. */
  emailAbandonedCart: boolean;
  /** Post-purchase review-request emails. */
  emailReviewRequests: boolean;
  /**
   * "You have a new message from PennPaps customer service" nudge
   * sent when a CSR replies on the in-account thread. Default ON
   * because the customer is unlikely to know they have a reply
   * otherwise; surfaced as a toggle on /account so they can mute.
   */
  emailInAppReplyNotifications: boolean;
  /**
   * Billing / patient-responsibility statement emails. A transactional
   * account notice (a bill the patient owes), so default ON — surfaced
   * as a toggle on /account so a patient who pays another way can mute.
   */
  emailBillingStatements: boolean;
  /** Marketing SMS. Promotions etc. */
  smsMarketing: boolean;
  /** Transactional SMS (order shipped, delivered). Off by default. */
  smsTransactional: boolean;
  /** Channel preference when both apply (e.g. shipped events). */
  preferredChannel: "email" | "sms";
  /** DND start (0-23, customer's local timezone). null = no DND. */
  dndStartHour: number | null;
  /** DND end (0-23, exclusive). null = no DND. */
  dndEndHour: number | null;
  /** IANA timezone ID for evaluating DND windows server-side. */
  timezone: string | null;
}

export const DEFAULT_COMMUNICATION_PREFERENCES: CommunicationPreferences = {
  emailMarketing: false,
  emailResupplyReminders: true,
  emailAbandonedCart: true,
  emailReviewRequests: true,
  emailInAppReplyNotifications: true,
  emailBillingStatements: true,
  smsMarketing: false,
  smsTransactional: false,
  preferredChannel: "email",
  dndStartHour: null,
  dndEndHour: null,
  timezone: null,
};

// ────────────────────────────────────────────────────────────────
// Shop abandoned-cart line-item shape (resupply.shop_abandoned_carts.items)
// ────────────────────────────────────────────────────────────────

/** A single line item inside a serialized abandoned-cart snapshot. */
export interface ShopAbandonedCartItem {
  /** Stripe one-time price ID (cart's stable per-line key). */
  priceId: string;
  /** Stripe product ID, for re-linking to the live catalog. */
  productId: string;
  /** Display name from the catalog at snapshot time. */
  name: string;
  /** Quantity (1..20). */
  quantity: number;
  /** Per-unit one-time amount in cents at snapshot time. */
  unitAmountCents: number;
  /** Currency code at snapshot time, lowercase per Stripe convention. */
  currency: string;
  /**
   * "one_time" or "subscription" — preserved across rehydration so
   * the restored cart respects the patient's per-line toggle.
   */
  mode: "one_time" | "subscription";
  /** Recurring (Stripe) price ID, if any. Null for masks. */
  recurringPriceId: string | null;
  /** Pre-rendered cadence label like "month" or "3 months". */
  recurringIntervalLabel: string | null;
  /** Catalog image URL at snapshot time. */
  imageUrl: string | null;
  /** Bundle flag — preserved so the restored cart renders correctly. */
  isBundle: boolean;
}

// ────────────────────────────────────────────────────────────────
// Shop customer JSONB shapes (continued)
// ────────────────────────────────────────────────────────────────

/** The customer's CPAP machine, captured on /account. JSONB column. */
export interface CpapDeviceInfo {
  manufacturer: string;
  model: string;
  serialNumber?: string | null;
  /** Human-readable, e.g. "8-12 cm H2O" or "10 cm H2O fixed". */
  pressureSetting?: string | null;
  /** Humidifier level if the device supports one, e.g. "3" or "auto". */
  humidifierSetting?: string | null;
  /** Free-form notes the customer wants to share with PennPaps. */
  notes?: string | null;
}

/** Prescribing physician — JSONB column on shop_customers. */
export interface PhysicianInfo {
  name: string;
  practice?: string | null;
  phone?: string | null;
  fax?: string | null;
  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  /** National Provider Identifier — 10-digit NPI for downstream EHR lookups. */
  npi?: string | null;
}

/**
 * On-device facial measurements captured by the fitter (MediaPipe
 * face-mesh, calibrated against the iris diameter ~11.7 mm). JSONB
 * on shop_customers so /account and admin Customer 360 can show the
 * latest values without replaying every order.
 */
export interface FacialMeasurementsInfo {
  noseWidth: number;
  noseHeight: number;
  noseToChin: number;
  mouthWidth: number;
  faceWidthAtCheekbones: number;
  calibrationMethod: "iris" | "manual_card";
  /** ISO timestamp the measurements were captured. */
  capturedAt: string;
}

// ────────────────────────────────────────────────────────────────
// Patient check-in attempts (resupply.patient_checkin_attempts.channel)
// ────────────────────────────────────────────────────────────────

export type CheckinAttemptChannel = "email" | "sms" | "voice";

// ────────────────────────────────────────────────────────────────
// CSR compliance alerts (resupply.csr_compliance_alerts)
// ────────────────────────────────────────────────────────────────

export type CsrComplianceAlertType =
  | "low_usage"
  | "no_response"
  | "send_failure"
  | "manual";

export type CsrComplianceAlertSeverity = "info" | "warning" | "critical";

export type CsrComplianceAlertStatus = "open" | "snoozed" | "resolved";

// ────────────────────────────────────────────────────────────────
// Insurance lead status (resupply.insurance_leads.status)
// ────────────────────────────────────────────────────────────────

export type InsuranceLeadStatus = "new" | "contacted" | "verified" | "closed";

export const INSURANCE_LEAD_STATUSES: readonly InsuranceLeadStatus[] = [
  "new",
  "contacted",
  "verified",
  "closed",
] as const;

// ────────────────────────────────────────────────────────────────
// Shop returns (resupply.shop_returns)
// ────────────────────────────────────────────────────────────────

export type ShopReturnStatus =
  | "requested"
  | "approved"
  | "rejected"
  | "shipped_back"
  | "received"
  | "refunded"
  | "replaced"
  | "closed";

export type ShopReturnReason =
  | "fit"
  | "defective"
  | "wrong_item"
  | "no_longer_needed"
  | "other";

// ────────────────────────────────────────────────────────────────
// Shop subscriptions (resupply.shop_subscriptions.items snapshot)
// ────────────────────────────────────────────────────────────────

export interface ShopSubscriptionItemSnapshot {
  /** Stripe price ID (recurring). */
  priceId: string;
  /** Stripe product ID. */
  productId: string | null;
  /** Quantity charged per cycle. */
  quantity: number;
  /** Display name from Stripe Product, snapshot at event time. */
  name: string | null;
  /** Per-unit amount in cents at event time. */
  unitAmountCents: number | null;
  /** Currency code at event time. */
  currency: string | null;
  /** Recurring interval label, e.g. "month" or "3 months". */
  intervalLabel: string | null;
}

// ────────────────────────────────────────────────────────────────
// Smart trigger events (resupply.patient_smart_trigger_events.kind)
// ────────────────────────────────────────────────────────────────

export type SmartTriggerKind =
  | "leak_rising"
  | "usage_dropping"
  | "cushion_wear"
  | "humidifier_drop";

export const SMART_TRIGGER_KINDS: ReadonlyArray<SmartTriggerKind> = [
  "leak_rising",
  "usage_dropping",
  "cushion_wear",
  "humidifier_drop",
];

// ────────────────────────────────────────────────────────────────
// Phase 12 — payer enrollment status (migration 0142)
// ────────────────────────────────────────────────────────────────

export const PAYER_ENROLLMENT_STATUS_VALUES = [
  "unknown",
  "not_required",
  "pending",
  "active",
  "suspended",
] as const;
export type PayerEnrollmentStatus =
  (typeof PAYER_ENROLLMENT_STATUS_VALUES)[number];

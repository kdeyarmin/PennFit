// Pure audience resolver for bulk_campaigns.
//
// Takes the resolved-from-DB candidate rows (patients OR shop
// customers, depending on audience_kind) and converts them into
// the recipient projection the route persists into
// bulk_campaign_recipients.
//
// Encapsulates three decisions:
//   1. Which row maps to which `recipient_kind` (patient vs.
//      shop_customer).
//   2. Whether the recipient is `pending` (will receive) or
//      `suppressed` (will not).
//   3. The `suppression_reason` for any suppressed recipient,
//      drawn from a small documented set.
//
// The resolver is CHANNEL-AWARE: for an email campaign it reads the
// recipient's email + email comm-prefs and snapshots the address; for an
// SMS campaign it reads the phone + SMS comm-prefs and snapshots the E.164
// number. The non-matching contact column is left null on the recipient.
//
// PURE — no DB, no Date.now(), no logging. Caller fetches the
// candidates; this function decides the disposition.
//
// Suppression reasons (the only legal values for
// suppression_reason on bulk_campaign_recipients):
//
//   * "no_email"              — email campaign, recipient has no email
//   * "no_phone"              — sms campaign, recipient has no phone
//   * "opted_out_marketing"   — email marketing, recipient flipped
//                                emailMarketing=false
//   * "opted_out_service"     — email service, recipient flipped
//                                emailResupplyReminders=false
//   * "sms_not_opted_in"       — sms campaign, recipient hasn't explicitly
//                                opted in (smsMarketing/smsTransactional not
//                                true) — SMS is opt-in (TCPA)
//   * "patient_not_active"    — patient.status !== 'active' (only the
//                                patient branches)
//   * "duplicate"             — same (kind, id) already in the resolved
//                                list; resolver collapses these
//
// Compliance category bypasses the opted_out_* reasons — recall notices and
// HIPAA-mandated communications override marketing/service preferences. It
// does NOT bypass patient_not_active: a paused patient texted STOP /
// unsubscribed, which is an absolute opt-out we never override.

export type Category = "marketing" | "service" | "compliance";

export type Channel = "email" | "sms";

/** Classified phone line type (resupply.{patients,shop_customers}). */
export type PhoneLineType = "mobile" | "landline" | "voip" | "unknown";

/** SMS is suppressed only for a KNOWN non-mobile line (landline / VoIP).
 *  'mobile' and the not-yet-known states (null / 'unknown') are allowed,
 *  per the allow-unknown / block-known-non-mobile policy. */
export function isKnownNonMobileLineType(
  lt: PhoneLineType | null | undefined,
): boolean {
  return lt === "landline" || lt === "voip";
}

export type AudienceKind =
  | "all_active_shop_customers"
  | "all_active_patients"
  | "by_patient_payer"
  // RT clinical cohort (C-R1): patients with an open compliance alert of a
  // given type (low adherence / no check-in response / at-risk). The route
  // pre-resolves the cohort to patient candidates and carries the cohort
  // key in `audiencePayer`, so this resolver treats them like any other
  // patient audience — the payer-filter guard below only fires for
  // by_patient_payer.
  | "by_therapy_cohort"
  // Composable patient segment (migration 0397). The route resolves the
  // segment to patient candidates via fetch-candidates; this resolver
  // treats them like any other patient audience.
  | "patient_segment"
  | "manual_list";

export interface ShopCustomerCandidate {
  id: string;
  emailLower: string | null;
  /** E.164 phone captured at checkout (migration 0247); null when unset. */
  phoneE164?: string | null;
  /** Classified line type (migration 0398); gates SMS to non-landline. */
  phoneLineType?: PhoneLineType | null;
  /** The full communication_preferences jsonb, or null when the
   *  customer hasn't ever set them. Null is treated as the default
   *  set (see DEFAULT_COMMUNICATION_PREFERENCES on the schema). */
  communicationPreferences: {
    emailMarketing?: boolean;
    emailResupplyReminders?: boolean;
    smsMarketing?: boolean;
    smsTransactional?: boolean;
  } | null;
}

export interface PatientCandidate {
  id: string;
  email: string | null;
  /** E.164 phone (patients.phone_e164); null when unset. */
  phone?: string | null;
  /** Classified line type (migration 0398); gates SMS to non-landline. */
  phoneLineType?: PhoneLineType | null;
  status: string;
  insurancePayer: string | null;
}

export interface ResolvedRecipient {
  recipientKind: "patient" | "shop_customer";
  recipientId: string;
  recipientEmail: string | null;
  recipientPhone: string | null;
  status: "pending" | "suppressed";
  suppressionReason: string | null;
}

export type SuppressionReason =
  | "no_email"
  | "no_phone"
  | "phone_not_mobile"
  | "opted_out_marketing"
  | "opted_out_service"
  | "sms_not_opted_in"
  | "patient_not_active"
  | "duplicate";

export interface ResolveAudienceInput {
  audienceKind: AudienceKind;
  audiencePayer: string | null;
  category: Category;
  /** Delivery channel. Defaults to "email" for back-compat with callers
   *  (and tests) that predate the SMS channel. */
  channel?: Channel;
  /** Candidate shop customers — populated when audienceKind is
   *  all_active_shop_customers (or when a future composite audience
   *  pulls customers). */
  shopCustomers?: ShopCustomerCandidate[];
  /** Candidate patients — populated when audienceKind is
   *  all_active_patients, by_patient_payer, by_therapy_cohort, or
   *  patient_segment. */
  patients?: PatientCandidate[];
  /** Manual recipient lists for audienceKind=manual_list. The route
   *  resolves the ids to candidates and passes them through the
   *  same shopCustomers / patients buckets above; resolveAudience
   *  doesn't fetch DB rows itself. */
}

export interface ResolveAudienceResult {
  recipients: ResolvedRecipient[];
  /** Convenience totals so the caller can persist them onto the
   *  bulk_campaigns row without re-walking the recipients array. */
  totals: {
    total: number;
    pending: number;
    suppressed: number;
  };
}

export function resolveAudience(
  input: ResolveAudienceInput,
): ResolveAudienceResult {
  const channel: Channel = input.channel ?? "email";
  const recipients: ResolvedRecipient[] = [];
  const seen = new Set<string>(); // dedupe key: `${kind}:${id}`

  for (const c of input.shopCustomers ?? []) {
    const key = `shop_customer:${c.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const email = (c.emailLower ?? "").trim() || null;
    const phone = (c.phoneE164 ?? "").trim() || null;
    const contact = channel === "sms" ? phone : email;
    const recipientEmail = channel === "sms" ? null : email;
    const recipientPhone = channel === "sms" ? phone : null;

    const push = (
      status: ResolvedRecipient["status"],
      suppressionReason: string | null,
    ): void => {
      recipients.push({
        recipientKind: "shop_customer",
        recipientId: c.id,
        recipientEmail,
        recipientPhone,
        status,
        suppressionReason,
      });
    };

    if (!contact) {
      push("suppressed", channel === "sms" ? "no_phone" : "no_email");
      continue;
    }
    if (channel === "sms" && isKnownNonMobileLineType(c.phoneLineType)) {
      push("suppressed", "phone_not_mobile");
      continue;
    }
    const prefs = c.communicationPreferences ?? {};
    if (input.category === "marketing") {
      // SMS is OPT-IN: the platform default for smsMarketing/smsTransactional
      // is false (DEFAULT_COMMUNICATION_PREFERENCES), so a missing/null pref
      // means "not opted in" — never text them (TCPA). Email stays opt-out
      // ("send unless they said no"), the codebase's established convention.
      if (channel === "sms" && prefs.smsMarketing !== true) {
        push("suppressed", "sms_not_opted_in");
        continue;
      }
      if (channel === "email" && prefs.emailMarketing === false) {
        push("suppressed", "opted_out_marketing");
        continue;
      }
    }
    if (input.category === "service") {
      if (channel === "sms" && prefs.smsTransactional !== true) {
        push("suppressed", "sms_not_opted_in");
        continue;
      }
      if (channel === "email" && prefs.emailResupplyReminders === false) {
        push("suppressed", "opted_out_service");
        continue;
      }
    }
    // compliance category bypasses opt-out — recall/HIPAA notice.
    push("pending", null);
  }

  for (const p of input.patients ?? []) {
    const key = `patient:${p.id}`;
    if (seen.has(key)) continue;

    // Payer filter when audience_kind=by_patient_payer.
    // Checked BEFORE the status/email gates so out-of-audience
    // patients are silently dropped rather than surfacing as
    // "suppressed because paused" — they're not in the cohort at
    // all. The DB query in the route normally pre-filters; this
    // is a defensive guard for misuse.
    if (
      input.audienceKind === "by_patient_payer" &&
      input.audiencePayer &&
      (p.insurancePayer ?? "").trim().toLowerCase() !==
        input.audiencePayer.trim().toLowerCase()
    ) {
      continue; // patient isn't really in the audience
    }
    seen.add(key);

    const email = (p.email ?? "").trim() || null;
    const phone = (p.phone ?? "").trim() || null;
    const contact = channel === "sms" ? phone : email;
    const recipientEmail = channel === "sms" ? null : email;
    const recipientPhone = channel === "sms" ? phone : null;

    const push = (
      status: ResolvedRecipient["status"],
      suppressionReason: string | null,
    ): void => {
      recipients.push({
        recipientKind: "patient",
        recipientId: p.id,
        recipientEmail,
        recipientPhone,
        status,
        suppressionReason,
      });
    };

    if (p.status !== "active") {
      // A non-active patient (paused = texted STOP / unsubscribed) is an
      // absolute opt-out — suppressed even for compliance category.
      push("suppressed", "patient_not_active");
      continue;
    }
    if (!contact) {
      push("suppressed", channel === "sms" ? "no_phone" : "no_email");
      continue;
    }
    if (channel === "sms" && isKnownNonMobileLineType(p.phoneLineType)) {
      push("suppressed", "phone_not_mobile");
      continue;
    }
    // Patient comm-prefs live elsewhere (no jsonb on patients itself).
    // Active patients with contact on file are pending; the at-send
    // re-check in the worker catches anyone who opts out mid-campaign.
    push("pending", null);
  }

  const pending = recipients.filter((r) => r.status === "pending").length;
  const suppressed = recipients.length - pending;
  return {
    recipients,
    totals: {
      total: recipients.length,
      pending,
      suppressed,
    },
  };
}

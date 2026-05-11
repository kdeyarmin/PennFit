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
// PURE — no DB, no Date.now(), no logging. Caller fetches the
// candidates; this function decides the disposition.
//
// Suppression reasons (the only legal values for
// suppression_reason on bulk_campaign_recipients):
//
//   * "no_email"          — recipient has no email on file
//   * "opted_out_marketing" — category=marketing and the recipient
//                              flipped emailMarketing=false
//   * "opted_out_service"   — category=service and the recipient
//                              flipped emailResupplyReminders=false
//   * "patient_not_active" — patient.status !== 'active' (only
//                              the patient branches)
//   * "duplicate"          — same (kind, id) already in the resolved
//                              list; resolver collapses these
//
// Compliance category bypasses opted_out_* — recall notices and
// HIPAA-mandated communications override marketing preferences.
// The CSR creating the campaign attests this on the row.

export type Category = "marketing" | "service" | "compliance";

export type AudienceKind =
  | "all_active_shop_customers"
  | "all_active_patients"
  | "by_patient_payer"
  | "manual_list";

export interface ShopCustomerCandidate {
  id: string;
  emailLower: string | null;
  /** The full communication_preferences jsonb, or null when the
   *  customer hasn't ever set them. Null is treated as the default
   *  set (see DEFAULT_COMMUNICATION_PREFERENCES on the schema). */
  communicationPreferences: {
    emailMarketing?: boolean;
    emailResupplyReminders?: boolean;
  } | null;
}

export interface PatientCandidate {
  id: string;
  email: string | null;
  status: string;
  insurancePayer: string | null;
}

export interface ResolvedRecipient {
  recipientKind: "patient" | "shop_customer";
  recipientId: string;
  recipientEmail: string | null;
  status: "pending" | "suppressed";
  suppressionReason: string | null;
}

export type SuppressionReason =
  | "no_email"
  | "opted_out_marketing"
  | "opted_out_service"
  | "patient_not_active"
  | "duplicate";

export interface ResolveAudienceInput {
  audienceKind: AudienceKind;
  audiencePayer: string | null;
  category: Category;
  /** Candidate shop customers — populated when audienceKind is
   *  all_active_shop_customers (or when a future composite audience
   *  pulls customers). */
  shopCustomers?: ShopCustomerCandidate[];
  /** Candidate patients — populated when audienceKind is
   *  all_active_patients or by_patient_payer. */
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
  const recipients: ResolvedRecipient[] = [];
  const seen = new Set<string>(); // dedupe key: `${kind}:${id}`

  for (const c of input.shopCustomers ?? []) {
    const key = `shop_customer:${c.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const email = (c.emailLower ?? "").trim() || null;
    if (!email) {
      recipients.push({
        recipientKind: "shop_customer",
        recipientId: c.id,
        recipientEmail: null,
        status: "suppressed",
        suppressionReason: "no_email",
      });
      continue;
    }
    const prefs = c.communicationPreferences ?? {};
    if (
      input.category === "marketing" &&
      prefs.emailMarketing === false
    ) {
      recipients.push({
        recipientKind: "shop_customer",
        recipientId: c.id,
        recipientEmail: email,
        status: "suppressed",
        suppressionReason: "opted_out_marketing",
      });
      continue;
    }
    if (
      input.category === "service" &&
      prefs.emailResupplyReminders === false
    ) {
      recipients.push({
        recipientKind: "shop_customer",
        recipientId: c.id,
        recipientEmail: email,
        status: "suppressed",
        suppressionReason: "opted_out_service",
      });
      continue;
    }
    // compliance category bypasses opt-out — recall/HIPAA notice.
    recipients.push({
      recipientKind: "shop_customer",
      recipientId: c.id,
      recipientEmail: email,
      status: "pending",
      suppressionReason: null,
    });
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

    if (p.status !== "active") {
      recipients.push({
        recipientKind: "patient",
        recipientId: p.id,
        recipientEmail: p.email,
        status: "suppressed",
        suppressionReason: "patient_not_active",
      });
      continue;
    }
    const email = (p.email ?? "").trim() || null;
    if (!email) {
      recipients.push({
        recipientKind: "patient",
        recipientId: p.id,
        recipientEmail: null,
        status: "suppressed",
        suppressionReason: "no_email",
      });
      continue;
    }
    // Patient comm-prefs live elsewhere (no jsonb on patients
    // itself in this sprint). Service category sends always go;
    // marketing sends to patients are reserved for compliance-
    // category recall flows in practice, so the marketing-opt-out
    // branch isn't reachable from a patient audience until
    // patient-side comm prefs are added.
    recipients.push({
      recipientKind: "patient",
      recipientId: p.id,
      recipientEmail: email,
      status: "pending",
      suppressionReason: null,
    });
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

// Audience resolution for platform outreach campaigns.
//
// Turns an (audienceKind, payload) pair into a concrete, de-duplicated
// recipient list, snapshotted into platform_email_recipients at draft
// time so the count + list stay stable as the underlying data shifts.
//
// Audiences:
//   * all_tenants / selected_tenants — the ACTIVE owner accounts
//     (admin_users role='admin', status='active') of each active org.
//   * all_contacts / contacts_by_tag — saved platform_contacts.
//   * manual_list — ad-hoc pasted addresses (cold / blind marketing).
//
// Suppression: a recipient is kept but marked 'suppressed' (never sent)
// when its email is blank/invalid, a duplicate within the campaign, or
// belongs to a contact who has unsubscribed. Honoring unsubscribe is
// cross-audience: a pasted address that matches an unsubscribed contact
// is suppressed too.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

export type PlatformAudienceKind =
  | "all_tenants"
  | "selected_tenants"
  | "all_contacts"
  | "contacts_by_tag"
  | "manual_list";

export type RecipientKind = "tenant" | "contact" | "manual";

export interface PlatformAudienceInput {
  audienceKind: PlatformAudienceKind;
  /** organizations.id list for selected_tenants. */
  tenantIds?: string[];
  /** tag to match for contacts_by_tag. */
  tag?: string;
  /** raw addresses for manual_list. */
  emails?: string[];
}

export interface ResolvedRecipient {
  recipientKind: RecipientKind;
  recipientRef: string | null;
  recipientEmail: string;
  recipientName: string | null;
  status: "pending" | "suppressed";
  suppressionReason: string | null;
}

export interface ResolveResult {
  recipients: ResolvedRecipient[];
  totals: { total: number; pending: number; suppressed: number };
}

// Deliberately permissive — we only reject obviously-malformed addresses
// (no @, whitespace). SendGrid does the authoritative validation.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Candidate {
  kind: RecipientKind;
  ref: string | null;
  email: string;
  name: string | null;
}

export async function resolvePlatformAudience(
  input: PlatformAudienceInput,
): Promise<ResolveResult> {
  const supabase = getSupabaseServiceRoleClient();
  const candidates: Candidate[] = [];

  if (
    input.audienceKind === "all_tenants" ||
    input.audienceKind === "selected_tenants"
  ) {
    // Active orgs (optionally narrowed to a selected set).
    let orgQuery = supabase
      .schema("resupply")
      .from("organizations")
      .select("id, name, slug")
      .eq("status", "active");
    if (input.audienceKind === "selected_tenants") {
      const ids = (input.tenantIds ?? []).filter(Boolean);
      if (ids.length === 0) {
        return {
          recipients: [],
          totals: { total: 0, pending: 0, suppressed: 0 },
        };
      }
      orgQuery = orgQuery.in("id", ids);
    }
    const { data: orgs, error: orgErr } = await orgQuery;
    if (orgErr) throw orgErr;
    const orgRows = orgs ?? [];
    if (orgRows.length > 0) {
      const orgById = new Map(orgRows.map((o) => [o.id as string, o] as const));
      // The tenant's human contacts: its active owner (admin) accounts.
      const { data: owners, error: ownerErr } = await supabase
        .schema("resupply")
        .from("admin_users")
        .select("org_id, email_lower, display_name, role, status")
        .in(
          "org_id",
          orgRows.map((o) => o.id as string),
        )
        .eq("role", "admin")
        .eq("status", "active");
      if (ownerErr) throw ownerErr;
      for (const owner of owners ?? []) {
        const org = orgById.get(owner.org_id as string);
        candidates.push({
          kind: "tenant",
          ref: (owner.org_id as string) ?? null,
          email: owner.email_lower,
          name:
            (owner.display_name as string | null) ??
            (org?.name as string | null) ??
            null,
        });
      }
    }
  } else if (
    input.audienceKind === "all_contacts" ||
    input.audienceKind === "contacts_by_tag"
  ) {
    let contactQuery = supabase
      .schema("resupply")
      .from("platform_contacts")
      .select("id, email, name");
    if (input.audienceKind === "contacts_by_tag") {
      const tag = (input.tag ?? "").trim();
      if (!tag) {
        return {
          recipients: [],
          totals: { total: 0, pending: 0, suppressed: 0 },
        };
      }
      contactQuery = contactQuery.contains("tags", [tag]);
    }
    const { data: contacts, error: contactErr } = await contactQuery;
    if (contactErr) throw contactErr;
    for (const c of contacts ?? []) {
      candidates.push({
        kind: "contact",
        ref: c.id as string,
        email: c.email as string,
        name: (c.name as string | null) ?? null,
      });
    }
  } else if (input.audienceKind === "manual_list") {
    for (const raw of input.emails ?? []) {
      const email = String(raw).trim();
      if (email.length === 0) continue;
      candidates.push({ kind: "manual", ref: null, email, name: null });
    }
  }

  // Cross-audience unsubscribe honor: every email a contact has opted out
  // of is suppressed regardless of how it entered the audience.
  const { data: unsub, error: unsubErr } = await supabase
    .schema("resupply")
    .from("platform_contacts")
    .select("email")
    .eq("unsubscribed", true);
  if (unsubErr) throw unsubErr;
  const unsubscribed = new Set(
    (unsub ?? []).map((r) => (r.email as string).trim().toLowerCase()),
  );

  const seen = new Set<string>();
  const recipients: ResolvedRecipient[] = [];
  for (const c of candidates) {
    const email = c.email.trim();
    const lower = email.toLowerCase();
    let status: "pending" | "suppressed" = "pending";
    let reason: string | null = null;
    if (email.length === 0 || !EMAIL_RE.test(email)) {
      status = "suppressed";
      reason = email.length === 0 ? "no_email" : "invalid_email";
    } else if (seen.has(lower)) {
      status = "suppressed";
      reason = "duplicate";
    } else if (unsubscribed.has(lower)) {
      status = "suppressed";
      reason = "unsubscribed";
    }
    if (status === "pending") seen.add(lower);
    recipients.push({
      recipientKind: c.kind,
      recipientRef: c.ref,
      recipientEmail: email,
      recipientName: c.name,
      status,
      suppressionReason: reason,
    });
  }

  const suppressed = recipients.filter((r) => r.status === "suppressed").length;
  return {
    recipients,
    totals: {
      total: recipients.length,
      pending: recipients.length - suppressed,
      suppressed,
    },
  };
}

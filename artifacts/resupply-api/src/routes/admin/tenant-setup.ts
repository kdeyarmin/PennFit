// /admin/organization/setup-checklist — the PER-TENANT onboarding checklist.
//
// Distinct from /platform/account-setup (the platform super-admin's
// deployment launch checklist). THIS surface is what a freshly signed-up
// tenant owner uses to stand up their OWN workspace: branding, custom
// domain, phone / SMS / fax numbers, email sender, and team. Every item
// links to the admin page that configures it.
//
// Read-only and gated by the coarse `requireAdmin` (not a fine permission)
// so it can power the dashboard "Finish setting up" card for ANY admin —
// the linked pages enforce their own owner-tier permissions on write.
//
// Privacy posture: no env values, no PHI — only "is this configured?"
// booleans derived from the tenant's own organizations row plus a small
// active-admin count. Every DB read is wrapped so the checklist still
// renders if a probe hiccups.

import { Router, type IRouter } from "express";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger.js";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit.js";
import { requireAdmin } from "../../middlewares/requireAdmin.js";

const router: IRouter = Router();

export type TenantSetupStatus = "complete" | "incomplete" | "action";

export interface TenantSetupItem {
  id: string;
  group: string;
  title: string;
  description: string;
  status: TenantSetupStatus;
  /** Live detail line, or null. */
  detail: string | null;
  /** SPA route the operator opens to configure this, or null. */
  href: string | null;
  /** Core launch item (counts toward the required meter) vs. recommended. */
  required: boolean;
}

/** The org columns + counts the assembler reasons over. */
export interface TenantSetupSnapshot {
  storefrontName: string | null;
  logoUrl: string | null;
  customDomain: string | null;
  customDomainStatus: string | null;
  voiceFromNumber: string | null;
  smsFromNumber: string | null;
  messagingServiceSid: string | null;
  faxFromNumber: string | null;
  fromEmail: string | null;
  activeAdminCount: number;
  /** Count of patients in the tenant's workspace (drives the "add/import
   *  patients" item). 0 for a brand-new tenant. */
  patientCount: number;
}

/**
 * Pure assembler — given the tenant snapshot, produce the ordered
 * checklist. Kept free of I/O so it's exhaustively unit-testable.
 */
export function buildTenantSetupItems(
  s: TenantSetupSnapshot,
): TenantSetupItem[] {
  const set = (v: string | null | undefined): boolean =>
    typeof v === "string" && v.trim() !== "";

  const domainVerified =
    s.customDomainStatus === "verified" && set(s.customDomain);
  const smsReady = set(s.smsFromNumber) || set(s.messagingServiceSid);

  return [
    // ── Branding & domain ────────────────────────────────────────────
    {
      id: "branding",
      group: "Branding & domain",
      title: "Set your storefront name & logo",
      description:
        "Name, tagline, and logo shown on your storefront, documents, and patient messages.",
      status: set(s.storefrontName) ? "complete" : "incomplete",
      detail: set(s.storefrontName)
        ? `Storefront name set${set(s.logoUrl) ? " · logo uploaded" : " · no logo yet"}.`
        : "Not set — your workspace name is showing as a placeholder.",
      href: "/admin/storefront-branding",
      required: true,
    },
    {
      id: "custom-domain",
      group: "Branding & domain",
      title: "Connect your custom domain",
      description:
        "Serve your storefront on your own domain (e.g. shop.yourcompany.com) instead of the platform subdomain. Verify by adding a DNS record.",
      status: domainVerified ? "complete" : "incomplete",
      detail: domainVerified
        ? `Verified: ${s.customDomain}.`
        : set(s.customDomain)
          ? `Added ${s.customDomain} — verification ${s.customDomainStatus ?? "pending"}. Finish the DNS step.`
          : "Not connected — you're using the platform subdomain (works fine; a custom domain is recommended).",
      href: "/admin/storefront-branding",
      required: false,
    },

    // ── Phone, SMS & fax ─────────────────────────────────────────────
    {
      id: "sms-number",
      group: "Phone, SMS & fax",
      title: "Get your own SMS number",
      description:
        "Optional for now: texts already send on the shared platform number. Add your own number when you're ready for messages to come from you — typically as your volume grows.",
      status: smsReady ? "complete" : "incomplete",
      detail: smsReady
        ? set(s.smsFromNumber)
          ? `SMS number: ${s.smsFromNumber}.`
          : "Using a Twilio Messaging Service."
        : "Using the shared platform number — works today; add your own when you're ready to brand it.",
      href: "/admin/phone-settings",
      required: false,
    },
    {
      id: "voice-number",
      group: "Phone, SMS & fax",
      title: "Get a phone number for voice calls",
      description:
        "Your own caller ID for the automated voice agent's outbound calls and inbound call routing.",
      status: set(s.voiceFromNumber) ? "complete" : "incomplete",
      detail: set(s.voiceFromNumber)
        ? `Voice number: ${s.voiceFromNumber}.`
        : "Not set — voice calls fall back to the shared platform number.",
      href: "/admin/phone-settings",
      required: false,
    },
    {
      id: "fax-number",
      group: "Phone, SMS & fax",
      title: "Get a fax number",
      description:
        "Your own fax line for inbound documents (sleep studies, signed Rx) and outbound physician outreach.",
      status: set(s.faxFromNumber) ? "complete" : "incomplete",
      detail: set(s.faxFromNumber)
        ? `Fax number: ${s.faxFromNumber}.`
        : "Not set — faxes fall back to the platform default.",
      href: "/admin/fax-settings",
      required: false,
    },

    // ── Email ────────────────────────────────────────────────────────
    {
      id: "email-sender",
      group: "Email",
      title: "Set your email From address",
      description:
        "Send patient email from your own address. Requires authenticating your sending domain (SPF/DKIM) in SendGrid so mail isn't flagged as spam.",
      status: set(s.fromEmail) ? "complete" : "incomplete",
      detail: set(s.fromEmail)
        ? `Sending as ${s.fromEmail}.`
        : "Not set — email sends from the platform default address.",
      href: "/admin/email-settings",
      required: true,
    },

    // ── Your patients ────────────────────────────────────────────────
    {
      id: "patients",
      group: "Your patients",
      title: "Add or import your patients",
      description:
        "Bring your patient roster in. Migrating from another system? Import a CSV — your PacWare Patient List, or any CSV with column mapping. It's a fill-only sync that never overwrites existing data. Starting fresh? Patients populate automatically as orders and fittings come in.",
      status: s.patientCount > 0 ? "complete" : "action",
      detail:
        s.patientCount > 0
          ? `${s.patientCount}${s.patientCount >= 1000 ? "+" : ""} patient${s.patientCount === 1 ? "" : "s"} in your workspace.`
          : "No patients yet — import your existing list from PacWare, or they'll populate as you take orders.",
      href: "/admin/pacware",
      required: false,
    },

    // ── Team ─────────────────────────────────────────────────────────
    {
      id: "team",
      group: "Team",
      title: "Invite your team",
      description:
        "Add colleagues as admins or customer-service reps so you're not the only login.",
      status: s.activeAdminCount > 1 ? "complete" : "incomplete",
      detail:
        s.activeAdminCount > 1
          ? `${s.activeAdminCount} active staff accounts.`
          : "Just you so far — invite teammates from Team.",
      href: "/admin/team",
      required: false,
    },
  ];
}

async function loadSnapshot(orgId: string): Promise<TenantSetupSnapshot> {
  const base: TenantSetupSnapshot = {
    storefrontName: null,
    logoUrl: null,
    customDomain: null,
    customDomainStatus: null,
    voiceFromNumber: null,
    smsFromNumber: null,
    messagingServiceSid: null,
    faxFromNumber: null,
    fromEmail: null,
    activeAdminCount: 0,
    patientCount: 0,
  };

  try {
    const { data, error } = await getOrgScopedClient(orgId)
      .raw()
      .schema("resupply")
      .from("organizations")
      .select(
        "storefront_name, logo_url, custom_domain, custom_domain_status, voice_from_number, sms_from_number, twilio_messaging_service_sid, fax_from_number, from_email",
      )
      .eq("id", orgId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const r = (data ?? {}) as Record<string, unknown>;
    base.storefrontName = (r["storefront_name"] as string | null) ?? null;
    base.logoUrl = (r["logo_url"] as string | null) ?? null;
    base.customDomain = (r["custom_domain"] as string | null) ?? null;
    base.customDomainStatus =
      (r["custom_domain_status"] as string | null) ?? null;
    base.voiceFromNumber = (r["voice_from_number"] as string | null) ?? null;
    base.smsFromNumber = (r["sms_from_number"] as string | null) ?? null;
    base.messagingServiceSid =
      (r["twilio_messaging_service_sid"] as string | null) ?? null;
    base.faxFromNumber = (r["fax_from_number"] as string | null) ?? null;
    base.fromEmail = (r["from_email"] as string | null) ?? null;
  } catch (err) {
    logger.warn(
      { event: "tenant_setup_org_probe_failed", err },
      "tenant-setup: org snapshot probe failed",
    );
  }

  try {
    const { count, error } = await getOrgScopedClient(orgId)
      .from("admin_users")
      .select("*", { count: "exact", head: true })
      .eq("status", "active");
    if (error) throw error;
    base.activeAdminCount = count ?? 0;
  } catch (err) {
    logger.warn(
      { event: "tenant_setup_admin_count_failed", err },
      "tenant-setup: admin count probe failed",
    );
  }

  // Patient count (fail-soft): drives the "add or import your patients" item.
  // org-scoped client filters by org_id; head:true makes it a COUNT-only query.
  try {
    const { count, error } = await getOrgScopedClient(orgId)
      .from("patients")
      .select("*", { count: "exact", head: true });
    if (error) throw error;
    base.patientCount = count ?? 0;
  } catch (err) {
    logger.warn(
      { event: "tenant_setup_patient_count_failed", err },
      "tenant-setup: patient count probe failed",
    );
  }

  return base;
}

router.get(
  "/admin/organization/setup-checklist",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    const orgId = req.orgId?.trim();
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const snapshot = await loadSnapshot(orgId);
    const items = buildTenantSetupItems(snapshot);
    const requiredItems = items.filter((i) => i.required);
    const requiredDone = requiredItems.filter(
      (i) => i.status === "complete",
    ).length;
    res.json({
      generatedAt: new Date().toISOString(),
      items,
      summary: {
        requiredTotal: requiredItems.length,
        requiredDone,
        allRequiredDone:
          requiredItems.length > 0 && requiredDone === requiredItems.length,
      },
    });
  },
);

export default router;

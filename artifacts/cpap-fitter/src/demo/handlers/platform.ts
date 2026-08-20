// Platform super-admin console handlers (`/platform/*`).
//
// Covers the whole super-admin surface so every page of the platform
// console renders real demo data AND its actions work: the identity gate,
// the tenant directory + lifecycle (create / suspend / reactivate /
// impersonate), per-tenant feature flags, admins, usage and activity, the
// fleet dashboard (analytics, margin, health, overview), the billing
// console (catalog, fleet directory, MRR, activity, plan/add-on/usage
// writes), global infra config, the operator roster, the support queue,
// outreach (contacts + campaigns), vendor cost rates, connection tests,
// and the deployment launch checklist.
//
// Writes go through the session-scoped store in `fixtures/platform.ts`,
// so an action taken in the demo is reflected by the next read — suspend
// a tenant and the directory shows it suspended; clear the SendGrid key
// and the dashboard's vendor dot goes dark and the email connection test
// starts reporting `not_configured`.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import {
  demoPlatformBillingActivity,
  demoPlatformBillingCatalog,
  demoPlatformBillingSummary,
  demoPlatformMe,
  demoPlatformTenantBilling,
} from "../fixtures/platform-billing";
import {
  demoAccountSetup,
  demoCampaignAction,
  demoClearPlatformConfig,
  demoConnectionTest,
  demoConnectionTestStatus,
  demoCostRates,
  demoCreateCampaignDraft,
  demoCreateContact,
  demoCreateTenant,
  demoCreateTenantAdmin,
  demoDeleteContact,
  demoFleetOverview,
  demoGrantOperator,
  demoImpersonate,
  demoImportContacts,
  demoOperators,
  demoPlatformAnalytics,
  demoPlatformCampaign,
  demoPlatformCampaigns,
  demoPlatformConfig,
  demoPlatformConfigActivity,
  demoPlatformContacts,
  demoPlatformHealth,
  demoPlatformMargin,
  demoPlatformTicket,
  demoPlatformTickets,
  demoReplyPlatformTicket,
  demoRevokeOperator,
  demoSetPlatformConfig,
  demoSetPlatformTicketStatus,
  demoSetTenantStatus,
  demoStopImpersonation,
  demoTenantActivitySeries,
  demoTenantAdmins,
  demoTenantDetail,
  demoTenantDirectory,
  demoTenantFlagActivity,
  demoTenantFlags,
  demoTenantUsage,
  demoToggleTenantFlag,
  demoUnsubscribeContact,
  demoUpdateContact,
  demoUpdateCostRates,
} from "../fixtures/platform";

/** Parse a positive integer query param, else the fallback. */
function intParam(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/** 404 with the same body shape the real platform routes use. */
function notFound(error: string): Response {
  return json({ error }, 404);
}

export const platformHandlers: DemoHandler[] = [
  // ── Identity gate (PlatformConsole) ──────────────────────────────
  route("GET", "/resupply-api/platform/me", () => json(demoPlatformMe())),

  // ── Dashboard: fleet analytics, margin, health, overview ─────────
  route("GET", "/resupply-api/platform/analytics", (req) =>
    json(demoPlatformAnalytics(intParam(req.query.get("days"), 30))),
  ),
  route("GET", "/resupply-api/platform/margin", (req) =>
    json(demoPlatformMargin(intParam(req.query.get("days"), 30))),
  ),
  route("GET", "/resupply-api/platform/health", () =>
    json(demoPlatformHealth()),
  ),
  route("GET", "/resupply-api/platform/overview", () =>
    json(demoFleetOverview()),
  ),

  // ── Billing console (reads) ──────────────────────────────────────
  route("GET", "/resupply-api/platform/billing/summary", () =>
    json(demoPlatformBillingSummary()),
  ),
  route("GET", "/resupply-api/platform/billing/catalog", () =>
    json(demoPlatformBillingCatalog()),
  ),
  route("GET", "/resupply-api/platform/billing/tenants", () =>
    json(demoPlatformTenantBilling()),
  ),
  route("GET", "/resupply-api/platform/billing/activity", (req) =>
    json(demoPlatformBillingActivity(req.query.get("tenantId"))),
  ),

  // ── Billing console (writes) ─────────────────────────────────────
  // The demo has no Stripe account behind it, so these acknowledge the
  // operation and let the console's own refetch redraw from the seeded
  // fleet. Declared explicitly (rather than left to the router's
  // `{ ok: true }` fallback) so the shapes match what each caller reads.
  route(
    "POST",
    "/resupply-api/platform/billing/tenants/:id/preview",
    (req, p) => {
      const body = req.json<{ planCode?: string; addons?: unknown[] }>() ?? {};
      return json({
        tenantId: p.id,
        // A preview the console renders as "what this change will cost".
        current: { monthlyCents: 199700 },
        next: { monthlyCents: body.planCode === "launch" ? 79900 : 199700 },
        deltaCents: body.planCode === "launch" ? -119800 : 0,
        prorationCents: 0,
        effectiveAt: new Date().toISOString(),
      });
    },
  ),
  route(
    "PUT",
    "/resupply-api/platform/billing/tenants/:id/subscription",
    (req, p) =>
      json({
        tenantId: p.id,
        planCode: req.json<{ planCode?: string }>()?.planCode ?? null,
        ok: true,
      }),
  ),
  route(
    "PUT",
    "/resupply-api/platform/billing/tenants/:id/addons",
    (req, p) => {
      const body = req.json<{ addonCode?: string; quantity?: number }>() ?? {};
      return json({
        tenantId: p.id,
        addonCode: body.addonCode ?? null,
        quantity: body.quantity ?? 0,
        ok: true,
      });
    },
  ),
  route("POST", "/resupply-api/platform/billing/usage-events", (req) =>
    json({ recorded: true, event: req.json() ?? null }),
  ),
  route(
    "POST",
    "/resupply-api/platform/billing/tenants/:id/stripe/customer",
    (_req, p) =>
      json({ tenantId: p.id, stripeCustomerId: "cus_demo", created: false }),
  ),
  route(
    "POST",
    "/resupply-api/platform/billing/tenants/:id/stripe/subscription",
    (_req, p) =>
      json({
        tenantId: p.id,
        stripeSubscriptionId: "sub_demo",
        stripeStatus: "active",
        syncedAt: new Date().toISOString(),
      }),
  ),
  route("POST", "/resupply-api/platform/billing/tenants/resync-stripe", () =>
    json({ resynced: 2, failed: 0, skipped: 2 }),
  ),
  route("POST", "/resupply-api/platform/billing/catalog/stripe/sync", () =>
    json({ plansSynced: 4, addonsSynced: 6, errors: [] }),
  ),
  route("PUT", "/resupply-api/platform/billing/catalog/plans/:code", (req, p) =>
    json({ plan: { code: p.code, ...(req.json<object>() ?? {}) } }),
  ),
  route(
    "PUT",
    "/resupply-api/platform/billing/catalog/addons/:code",
    (req, p) =>
      json({ addon: { code: p.code, ...(req.json<object>() ?? {}) } }),
  ),

  // ── Tenant directory + lifecycle ─────────────────────────────────
  // Static sub-paths first: `/tenants/resync-stripe` above and the
  // `:id` routes below would otherwise collide (first match wins).
  route("GET", "/resupply-api/platform/tenants", () =>
    json(demoTenantDirectory()),
  ),
  route("POST", "/resupply-api/platform/tenants", (req) =>
    json(demoCreateTenant(req.json<{ slug?: string; name?: string }>()), 201),
  ),
  route("GET", "/resupply-api/platform/tenants/:id", (_req, p) => {
    const found = demoTenantDetail(p.id);
    return found ? json(found) : notFound("tenant_not_found");
  }),
  route("POST", "/resupply-api/platform/tenants/:id/suspend", (_req, p) => {
    const updated = demoSetTenantStatus(p.id, "suspended");
    return updated ? json(updated) : notFound("tenant_not_found");
  }),
  route("POST", "/resupply-api/platform/tenants/:id/reactivate", (_req, p) => {
    const updated = demoSetTenantStatus(p.id, "active");
    return updated ? json(updated) : notFound("tenant_not_found");
  }),
  route("GET", "/resupply-api/platform/tenants/:id/usage", (_req, p) =>
    json(demoTenantUsage(p.id)),
  ),
  route("GET", "/resupply-api/platform/tenants/:id/activity-series", (req, p) =>
    json(demoTenantActivitySeries(p.id, intParam(req.query.get("days"), 30))),
  ),

  // ── Per-tenant feature flags ─────────────────────────────────────
  route("GET", "/resupply-api/platform/tenants/:id/feature-flags", (_req, p) =>
    json(demoTenantFlags(p.id)),
  ),
  route(
    "PATCH",
    "/resupply-api/platform/tenants/:id/feature-flags/:key",
    (req, p) => {
      const enabled = req.json<{ enabled?: boolean }>()?.enabled ?? false;
      const updated = demoToggleTenantFlag(p.id, p.key, enabled);
      return updated ? json(updated) : notFound("flag_not_found");
    },
  ),
  route(
    "GET",
    "/resupply-api/platform/tenants/:id/feature-flag-activity",
    (req, p) =>
      json(demoTenantFlagActivity(p.id, intParam(req.query.get("limit"), 20))),
  ),

  // ── Per-tenant admins ────────────────────────────────────────────
  route("GET", "/resupply-api/platform/tenants/:id/admins", (_req, p) =>
    json(demoTenantAdmins(p.id)),
  ),
  route("POST", "/resupply-api/platform/tenants/:id/admins", (req, p) =>
    json(
      demoCreateTenantAdmin(
        p.id,
        req.json<{
          email?: string;
          role?: string;
          displayName?: string | null;
          initialPassword?: string | null;
        }>(),
      ),
      201,
    ),
  ),

  // ── Impersonation ────────────────────────────────────────────────
  route("POST", "/resupply-api/platform/tenants/:id/impersonate", (_req, p) =>
    json(demoImpersonate(p.id)),
  ),
  route("POST", "/resupply-api/platform/impersonation/stop", () =>
    json(demoStopImpersonation()),
  ),

  // ── Global integrations (platform app-config) ────────────────────
  // `/config/activity` before `/config/:key` — the param route would
  // otherwise swallow it.
  route("GET", "/resupply-api/platform/config/activity", (req) =>
    json(demoPlatformConfigActivity(intParam(req.query.get("limit"), 20))),
  ),
  route("GET", "/resupply-api/platform/config", () =>
    json(demoPlatformConfig()),
  ),
  route("PUT", "/resupply-api/platform/config/:key", (req, p) => {
    const value = req.json<{ value?: string }>()?.value ?? "";
    const updated = demoSetPlatformConfig(p.key, value);
    return updated ? json(updated) : notFound("unknown_setting");
  }),
  route("DELETE", "/resupply-api/platform/config/:key", (_req, p) => {
    const updated = demoClearPlatformConfig(p.key);
    return updated ? json(updated) : notFound("unknown_setting");
  }),

  // ── Operator roster ──────────────────────────────────────────────
  route("GET", "/resupply-api/platform/admins", () => json(demoOperators())),
  route("POST", "/resupply-api/platform/admins", (req) =>
    json(demoGrantOperator(req.json<{ email?: string }>()?.email)),
  ),
  route("DELETE", "/resupply-api/platform/admins/:authUserId", (_req, p) =>
    json(demoRevokeOperator(p.authUserId)),
  ),

  // ── Support queue ────────────────────────────────────────────────
  route("GET", "/resupply-api/platform/support/tickets", (req) =>
    json(demoPlatformTickets(req.query.get("status"))),
  ),
  route("GET", "/resupply-api/platform/support/tickets/:id", (_req, p) => {
    const found = demoPlatformTicket(p.id);
    return found ? json(found) : notFound("ticket_not_found");
  }),
  route(
    "POST",
    "/resupply-api/platform/support/tickets/:id/reply",
    (req, p) => {
      const body = req.json<{ body?: string }>()?.body ?? "";
      const updated = demoReplyPlatformTicket(p.id, body);
      return updated ? json(updated) : notFound("ticket_not_found");
    },
  ),
  route(
    "POST",
    "/resupply-api/platform/support/tickets/:id/status",
    (req, p) => {
      const status = req.json<{ status?: string }>()?.status ?? "open";
      const updated = demoSetPlatformTicketStatus(p.id, status);
      return updated ? json(updated) : notFound("ticket_not_found");
    },
  ),

  // ── Outreach: contacts ───────────────────────────────────────────
  // `/contacts/import` before `/contacts/:id` (first match wins).
  route("POST", "/resupply-api/platform/contacts/import", (req) =>
    json(
      demoImportContacts(
        req.json<{
          raw?: string;
          contacts?: Array<{
            email: string;
            name?: string | null;
            company?: string | null;
          }>;
          tags?: string[];
        }>(),
      ),
    ),
  ),
  route(
    "POST",
    "/resupply-api/platform/contacts/:id/unsubscribe",
    (_req, p) => {
      const updated = demoUnsubscribeContact(p.id);
      return updated ? json(updated) : notFound("contact_not_found");
    },
  ),
  route("GET", "/resupply-api/platform/contacts", (req) =>
    json(demoPlatformContacts(req.query.get("search"), req.query.get("tag"))),
  ),
  route("POST", "/resupply-api/platform/contacts", (req) =>
    json(
      demoCreateContact(
        req.json<{
          email?: string;
          name?: string | null;
          company?: string | null;
          tags?: string[];
          notes?: string | null;
        }>(),
      ),
      201,
    ),
  ),
  route("PATCH", "/resupply-api/platform/contacts/:id", (req, p) => {
    const updated = demoUpdateContact(p.id, req.json());
    return updated ? json(updated) : notFound("contact_not_found");
  }),
  route("DELETE", "/resupply-api/platform/contacts/:id", (_req, p) =>
    json(demoDeleteContact(p.id)),
  ),

  // ── Outreach: campaigns ──────────────────────────────────────────
  // `/email-campaigns/draft` before `/email-campaigns/:id`.
  route("POST", "/resupply-api/platform/email-campaigns/draft", (req) =>
    json(demoCreateCampaignDraft(req.json()), 201),
  ),
  route("GET", "/resupply-api/platform/email-campaigns", () =>
    json(demoPlatformCampaigns()),
  ),
  route("GET", "/resupply-api/platform/email-campaigns/:id", (_req, p) => {
    const found = demoPlatformCampaign(p.id);
    return found ? json(found) : notFound("campaign_not_found");
  }),
  ...(["start", "pause", "resume", "cancel"] as const).map((action) =>
    route(
      "POST",
      `/resupply-api/platform/email-campaigns/:id/${action}`,
      (_req, p) => {
        const updated = demoCampaignAction(p.id, action);
        return updated ? json(updated) : notFound("campaign_not_found");
      },
    ),
  ),

  // ── Vendor cost rates ────────────────────────────────────────────
  route("GET", "/resupply-api/platform/cost-rates", () =>
    json(demoCostRates()),
  ),
  route("PUT", "/resupply-api/platform/cost-rates", (req) =>
    json(demoUpdateCostRates(req.json())),
  ),

  // ── Connection tests ─────────────────────────────────────────────
  route("GET", "/resupply-api/platform/connection-tests/status", () =>
    json(demoConnectionTestStatus()),
  ),
  ...(["email", "sms", "voice"] as const).map((channel) =>
    route("POST", `/resupply-api/platform/connection-tests/${channel}`, (req) =>
      json(demoConnectionTest(channel, req.json<{ to?: string }>()?.to)),
    ),
  ),
  route("POST", "/resupply-api/platform/connection-tests/chat", () =>
    json(demoConnectionTest("chat")),
  ),

  // ── Deployment launch checklist ──────────────────────────────────
  route("GET", "/resupply-api/platform/account-setup", () =>
    json(demoAccountSetup()),
  ),
];

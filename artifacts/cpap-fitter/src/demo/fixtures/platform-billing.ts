// Demo fixtures for the super-admin platform billing console
// (/platform/billing). Reuses the tenant billing-package catalog so the
// fleet view is consistent with the tenant self-service demo. The activity
// feed shows both self-service (tenant) and super-admin events, exactly
// like the real tenant_billing_events feed (migration 0386).

import {
  demoSelectableAddons,
  demoSelectablePlans,
  demoTenantBilling,
} from "./billing-package";

/** GET /resupply-api/platform/me — platform-admin identity gate. */
export function demoPlatformMe() {
  return {
    userId: "demo-platform-admin-1",
    email: "demo.owner@pennfit.example",
  };
}

/** GET /platform/billing/catalog — fleet catalog (plans + add-ons). */
export function demoPlatformBillingCatalog() {
  return {
    plans: demoSelectablePlans().plans,
    addons: demoSelectableAddons().addons,
  };
}

/** GET /platform/billing/tenants — fleet directory with billing. */
export function demoPlatformTenantBilling() {
  const base = demoTenantBilling();
  return {
    tenants: [
      {
        id: "demo-tenant-1",
        slug: "penn-home-medical",
        name: "Penn Home Medical Supply",
        storefrontName: "PennPaps",
        status: "active",
        faxNumber: "+12155551212",
        faxProvisionedAt: new Date(Date.now() - 90 * 864e5).toISOString(),
        billing: base,
      },
      {
        id: "demo-tenant-2",
        slug: "acme-sleep",
        name: "Acme Sleep DME",
        storefrontName: "AcmeSleep",
        status: "active",
        faxNumber: null,
        faxProvisionedAt: null,
        billing: { ...base, tenantId: "demo-tenant-2" },
      },
    ],
  };
}

/** GET /platform/billing/summary — fleet MRR rollup. */
export function demoPlatformBillingSummary() {
  return {
    mrrCents: 568900,
    addonMrrCents: 9800,
    atRiskMrrCents: 0,
    arpuCents: 284450,
    payingTenants: 2,
    trialingTenants: 0,
    pastDueTenants: 0,
    unsubscribedTenants: 0,
    byPlan: [
      { planCode: "growth", planName: "Growth", tenants: 1, mrrCents: 189900 },
      { planCode: "launch", planName: "Launch", tenants: 1, mrrCents: 79900 },
    ],
    generatedAt: new Date().toISOString(),
  };
}

/** GET /platform/billing/activity — who changed what, when. */
export function demoPlatformBillingActivity() {
  const min = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
  return {
    activity: [
      {
        id: "evt-1",
        tenantId: "demo-tenant-1",
        tenantName: "Penn Home Medical Supply",
        action: "tenant.billing.subscription.selected",
        actor: "tenant" as const,
        operatorEmail: "owner@pennpaps.example",
        summary: "Switched to the Growth plan",
        metadata: { planCode: "growth" },
        occurredAt: min(8),
      },
      {
        id: "evt-2",
        tenantId: "demo-tenant-1",
        tenantName: "Penn Home Medical Supply",
        action: "tenant.billing.addon.updated",
        actor: "tenant" as const,
        operatorEmail: "owner@pennpaps.example",
        summary: "Set Additional staff seat to 2",
        metadata: { addonCode: "additional_seat", quantity: 2 },
        occurredAt: min(7),
      },
      {
        id: "evt-3",
        tenantId: "demo-tenant-2",
        tenantName: "Acme Sleep DME",
        action: "platform.billing.subscription.updated",
        actor: "platform" as const,
        operatorEmail: "demo.owner@pennfit.example",
        summary: "Assigned the Launch plan",
        metadata: { planCode: "launch" },
        occurredAt: min(40),
      },
      {
        id: "evt-4",
        tenantId: "demo-tenant-2",
        tenantName: "Acme Sleep DME",
        action: "platform.billing.addon.updated",
        actor: "platform" as const,
        operatorEmail: "demo.owner@pennfit.example",
        summary: "Set AI voice agent / IVR to 1",
        metadata: { addonCode: "ai_voice_agent", quantity: 1 },
        occurredAt: min(120),
      },
    ],
  };
}

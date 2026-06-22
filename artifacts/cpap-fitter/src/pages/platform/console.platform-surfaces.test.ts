// allow-source-read: structural invariant — that the three relocated
// global surfaces are wired into the platform console's router/nav. The
// behavioral equivalent (mounting <PlatformConsole/>) needs the platform
// `useGetPlatformMe` gate plus every dashboard data hook mocked; this
// mirrors the grandfathered source-grep in console.platform-billing.test.ts
// that pins the matching tenant-console wiring.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "console.tsx"), "utf8");

// Global/deployment surfaces that used to sit in the per-tenant /admin
// console now live on the platform super-admin console: cross-tenant
// billing, the deployment launch checklist, and deployment system info.
describe("platform console global surfaces", () => {
  it("mounts the cross-tenant platform billing page", () => {
    expect(SRC).toContain(
      'import { AdminPlatformBillingPage } from "@/pages/admin/admin-platform-billing"',
    );
    expect(SRC).toContain(
      '<Route path="/platform/billing" component={AdminPlatformBillingPage} />',
    );
    expect(SRC).toContain('href: "/platform/billing", label: "Billing"');
  });

  it("mounts the deployment launch checklist", () => {
    expect(SRC).toContain(
      'import { AdminAccountSetupPage } from "@/pages/admin/account-setup"',
    );
    expect(SRC).toContain('path="/platform/account-setup"');
    expect(SRC).toContain(
      'href: "/platform/account-setup", label: "Account setup"',
    );
  });

  it("mounts the deployment system-info page", () => {
    expect(SRC).toContain(
      'import { PlatformSystemInfoPage } from "@/pages/admin/admin-settings"',
    );
    expect(SRC).toContain(
      '<Route path="/platform/system" component={PlatformSystemInfoPage} />',
    );
    expect(SRC).toContain('href: "/platform/system", label: "System info"');
  });
});

// The overhaul added a tenant-detail drill-down and a grouped sidebar.
// Pin both so a refactor that drops them is caught.
describe("platform console tenant detail + sidebar", () => {
  it("mounts the tenant detail drill-down route", () => {
    expect(SRC).toContain(
      '<Route path="/platform/tenants/:id" component={TenantDetailPage} />',
    );
  });

  it("renders the grouped sidebar navigation", () => {
    expect(SRC).toContain("const PLATFORM_NAV_GROUPS");
    expect(SRC).toContain("function SidebarContent");
    expect(SRC).toContain('href: "/platform/tenants", label: "Directory"');
  });

  it("guards consequential tenant actions behind a confirmation dialog", () => {
    expect(SRC).toContain("function ConfirmDialog");
    expect(SRC).toContain('setConfirm({ kind: "impersonate", tenant: t })');
  });

  it("surfaces per-tenant flag history and a fleet attention panel", () => {
    expect(SRC).toContain("function RecentFlagActivityCard");
    expect(SRC).toContain("useTenantFeatureFlagActivity");
    expect(SRC).toContain("function NeedsAttentionCard");
    // The detail header offers a one-click storefront open + copyable slug.
    expect(SRC).toContain("Open storefront");
    expect(SRC).toContain("<CopyableId value={tenant.slug}");
  });

  it("adds a sidebar tenant quick-switcher and a support badge", () => {
    expect(SRC).toContain("function TenantQuickSwitcher");
    expect(SRC).toContain("<TenantQuickSwitcher onNavigate={onNavigate} />");
    // Support nav item carries a "needs reply" count badge.
    expect(SRC).toContain("supportNeedsReply");
  });

  it("charts per-tenant activity trends on the detail page", () => {
    expect(SRC).toContain("function TenantActivityCard");
    expect(SRC).toContain("useTenantActivitySeries");
    expect(SRC).toContain("<TenantActivityCard tenantId={tenant.id} />");
  });

  it("shows a per-tenant plan & billing snapshot on the detail page", () => {
    expect(SRC).toContain("function TenantBillingCard");
    expect(SRC).toContain("fetchPlatformTenantBilling");
    expect(SRC).toContain("<TenantBillingCard tenantId={tenant.id} />");
  });

  it("adds a ⌘K switcher shortcut and inline reactivate on attention", () => {
    expect(SRC).toContain('e.key.toLowerCase() === "k"');
    // The Needs-attention panel reactivates inline, not just links out.
    expect(SRC).toContain("onReactivate(t.id)");
  });
});

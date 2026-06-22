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
});

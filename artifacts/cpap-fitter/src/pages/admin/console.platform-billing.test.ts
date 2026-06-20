import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "console.tsx"), "utf8");

describe("admin console platform billing routes", () => {
  it("lazy-loads the tenant package and usage page", () => {
    expect(SRC).toContain("AdminBillingPackagePage");
    expect(SRC).toContain("@/pages/admin/admin-billing-package");
    expect(SRC).toContain('path="/admin/billing/package"');
  });

  it("does not mount the super-admin platform billing page in the tenant console", () => {
    // The cross-tenant platform billing page moved to the platform
    // super-admin console (/platform/billing); it must not be reachable
    // from the per-tenant /admin console.
    expect(SRC).not.toContain("AdminPlatformBillingPage");
    expect(SRC).not.toContain("admin-platform-billing");
    expect(SRC).not.toContain('path="/admin/platform-billing"');
  });
});

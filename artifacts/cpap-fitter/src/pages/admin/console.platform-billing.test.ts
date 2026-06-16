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

  it("lazy-loads the super-admin platform billing page", () => {
    expect(SRC).toContain("AdminPlatformBillingPage");
    expect(SRC).toContain("@/pages/admin/admin-platform-billing");
    expect(SRC).toContain('path="/admin/platform-billing"');
  });
});

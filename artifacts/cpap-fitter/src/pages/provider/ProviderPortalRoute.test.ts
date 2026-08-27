// Structural guards for provider portal host gating (source-string
// assertions — no DOM).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "ProviderPortalRoute.tsx"),
  "utf8",
);

describe("ProviderPortalRoute host gating", () => {
  it("distinguishes provider_tenant_host_required from generic no-access", () => {
    expect(SRC).toContain("provider_tenant_host_required");
    expect(SRC).toContain("WrongTenantHost");
    expect(SRC).toContain("provider-wrong-tenant-host");
    expect(SRC).toContain("isPlatformHomeHost");
  });

  it("still renders a generic NoAccess card for other 403s", () => {
    expect(SRC).toContain("function NoAccess");
    expect(SRC).toContain("No portal access");
  });
});

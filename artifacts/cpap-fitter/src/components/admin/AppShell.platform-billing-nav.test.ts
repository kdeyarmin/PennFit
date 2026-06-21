import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "AppShell.tsx"), "utf8");

describe("AppShell billing navigation", () => {
  it("exposes tenant-facing package and usage navigation", () => {
    expect(SRC).toContain('label: "Package & usage"');
    expect(SRC).toContain('href: "/admin/billing/package"');
  });

  it("does not expose platform billing in the tenant admin nav", () => {
    // Platform billing is a cross-tenant super-admin surface (assign
    // plans, pricing overrides, Stripe sync for every tenant) and now
    // lives on the platform console (/platform/billing), not the
    // per-tenant admin nav.
    expect(SRC).not.toContain('label: "Platform billing"');
    // Target the nav HREF specifically — a bare "/admin/platform-billing"
    // substring also matches the unrelated `@/lib/admin/platform-billing-api`
    // import (the tenant's own "Pay now" checkout client), which is fine.
    expect(SRC).not.toContain('href: "/admin/platform-billing"');
  });
});

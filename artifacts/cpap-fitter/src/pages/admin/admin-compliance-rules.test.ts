// Structural guards for the compliance-rules admin page (source-string
// assertions, no DOM — same pattern as rules.test.ts).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-compliance-rules.tsx"),
  "utf8",
);

describe("admin-compliance-rules page", () => {
  it("wraps its outer div in admin-root (CLAUDE.md scoping rule)", () => {
    expect(SRC).toContain('className="admin-root');
  });

  it("exports the AdminComplianceRulesPage component", () => {
    expect(SRC).toContain("export function AdminComplianceRulesPage");
  });

  it("uses the self-contained compliance-rules api helper", () => {
    expect(SRC).toContain("@/lib/admin/compliance-rules-api");
    expect(SRC).toContain("createComplianceRule");
    expect(SRC).toContain("updateComplianceRule");
    expect(SRC).toContain("deleteComplianceRule");
  });

  it("gates delete behind a destructive confirmation dialog", () => {
    expect(SRC).toContain("useConfirmDialog");
    expect(SRC).toContain('title: "Delete rule?"');
    expect(SRC).toContain("destructive: true");
  });

  it("hides delete from agents (admin-only)", () => {
    expect(SRC).toContain("useAdminRole");
    expect(SRC).toContain('role === "admin"');
    expect(SRC).toContain('role === "agent"');
  });

  it("caps required nights at 30 to match the server constraint", () => {
    expect(SRC).toContain("max={30}");
    expect(SRC).toContain("Required nights (of 30)");
  });
});

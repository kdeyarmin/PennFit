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

  it("exposes platform billing only behind system configuration permission", () => {
    const platformNavStart = SRC.indexOf('label: "Platform billing"');
    expect(platformNavStart).toBeGreaterThanOrEqual(0);
    const platformNavBlock = SRC.slice(
      platformNavStart,
      platformNavStart + 300,
    );
    expect(platformNavBlock).toContain(
      'matchPrefix: "/admin/platform-billing"',
    );
    expect(platformNavBlock).toContain(
      'requiredPermission: "system.config.manage"',
    );
  });
});

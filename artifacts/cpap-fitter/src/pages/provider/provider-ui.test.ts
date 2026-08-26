import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "provider-ui.tsx"), "utf8");

describe("provider-ui — platform-branded chrome", () => {
  it("uses PLATFORM_NAME instead of host-resolved tenant contact", () => {
    expect(SRC).toContain('import { PLATFORM_NAME } from "@/lib/branding"');
    expect(SRC).not.toContain("useCompanyContact");
    expect(SRC).toContain("{PLATFORM_NAME}");
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const adminDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(adminDir, "../..");
const appShellSource = readFileSync(
  path.join(adminDir, "AppShell.tsx"),
  "utf8",
);
const adminSupportSource = readFileSync(
  path.join(srcDir, "pages/admin/admin-support.tsx"),
  "utf8",
);

describe("AppShell central software-support integration", () => {
  it("routes only the admin Support nav item to the external Hub", () => {
    expect(appShellSource).toContain('href === "/admin/support"');
    expect(appShellSource).toContain("externalHref={");
    expect(appShellSource).toContain('target="_blank"');
    expect(appShellSource).toContain('rel="noopener noreferrer"');
  });

  it("derives outbound context from the static active nav destination", () => {
    expect(appShellSource).toContain(
      "staticRoute: staticAdminSupportRoute(location, visibleGroups)",
    );
    expect(appShellSource).not.toMatch(
      /buildCentralSupportUrl\(\{\s*staticRoute:\s*(?:window\.)?location/,
    );
    expect(appShellSource).not.toContain("window.location.pathname");
  });

  it("keeps the local support page behind the positive opt-in flag", () => {
    expect(adminSupportSource).toContain("function LocalAdminSupportPage()");
    expect(adminSupportSource).toContain("isCentralSupportHubEnabled() ?");
    expect(adminSupportSource).toContain("<LocalAdminSupportPage />");
  });
});

describe("patient/DME help boundary", () => {
  const patientFacingFiles = [
    "components/layout.tsx",
    "components/floating-contact-launcher.tsx",
    "components/mobile-cta-bar.tsx",
    "pages/help.tsx",
  ];

  for (const relativePath of patientFacingFiles) {
    it(`does not wire the central admin launcher into ${relativePath}`, () => {
      const source = readFileSync(path.join(srcDir, relativePath), "utf8");
      expect(source).not.toContain("central-support");
      expect(source).not.toContain("support-hub-web-production.up.railway.app");
    });
  }
});

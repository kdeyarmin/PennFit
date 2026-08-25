// Static source-level guard for which auth mounts are tenant-branded.
//
// The same `makeAuthRouter` is mounted three times, and the correct brand
// differs per mount — a distinction that is invisible at the callsite and
// easy to "tidy" into uniformity:
//
//   /resupply-api/auth   staff console   → PLATFORM. Internal tooling; the
//                                          console chrome already says
//                                          CareMetric Breathe, and this mail
//                                          fires before a tenant is resolved.
//   /api/auth            patient site    → TENANT. One bundle serves every
//                                          tenant's storefront, so a static
//                                          name welcomed a patient to a
//                                          product they had never heard of.
//   /api/provider/auth   provider portal → PLATFORM today (see the note on
//                                          the mount).
//
// A boot-and-POST test would need a live DB pool, SendGrid keys, and the
// auth router's full required env; the behavior itself is covered in
// lib/resupply-auth (brand.test.ts + account-flows.test.ts). What is NOT
// covered there is this wiring, which is exactly what a refactor would
// flatten — hence a source check.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.join(__dirname, "app.ts"), "utf8");

/** The `makeAuthRouter(...)` options block that follows a mount path. */
function mountBlock(mountPath: string): string {
  const at = APP_SOURCE.indexOf(`"${mountPath}"`);
  expect(at, `no app.use("${mountPath}") mount found`).toBeGreaterThan(-1);
  const from = APP_SOURCE.indexOf("makeAuthRouter", at);
  expect(from, `no makeAuthRouter for "${mountPath}"`).toBeGreaterThan(-1);
  // Up to the next mount, or 3k chars — enough for the options object.
  const next = APP_SOURCE.indexOf("app.use(", from);
  return APP_SOURCE.slice(from, next > from ? next : from + 3000);
}

describe("auth email branding by mount", () => {
  it("resolves the tenant brand on the patient storefront mount", () => {
    const block = mountBlock("/api/auth");
    expect(
      block,
      "The patient mount must resolve the brand per request — one bundle " +
        "serves every tenant's storefront.",
    ).toContain("resolveBrand:");
    // Host-derived, not hardcoded: the Host is what identifies the tenant
    // whose site the patient is actually on.
    expect(block).toContain("resolveOrgIdByHost");
    expect(block).toContain("resolveBrandingByOrgId");
    // The static names stay as the fail-soft floor.
    expect(block).toContain("PLATFORM_NAME");
  });

  it("keeps the staff console mount on the platform identity", () => {
    const block = mountBlock("/resupply-api/auth");
    expect(
      block,
      "Staff console mail is the software's own; it must not be " +
        "tenant-branded without a deliberate decision.",
    ).not.toContain("resolveBrand:");
    expect(block).toContain("PLATFORM_NAME");
  });

  it("keeps the provider portal mount on the platform identity", () => {
    const block = mountBlock("/api/provider/auth");
    expect(block).not.toContain("resolveBrand:");
    expect(block).toContain("PLATFORM_NAME");
  });
});

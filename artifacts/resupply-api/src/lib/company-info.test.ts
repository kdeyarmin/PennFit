// company-info resolver: the central "what is this company called and
// how do patients reach it" answer.
//
//   1. DB row wins: dba_name (else legal_name) becomes the display
//      name; support fields fall back to the main phone / emails.
//   2. No DB row → RESUPPLY_PRACTICE_NAME env → hardcoded defaults.
//   3. A DB error degrades to env + defaults (fail-soft, never throws).
//   4. hydrateCompanyInfoCache warms the sync cache and writes NOTHING to
//      process.env (the old fold leaked the seed tenant's brand globally).
//   5. applyCompanyIdentityToText rewrites the historical hardcoded
//      strings only once the DB row exists.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// Mock the per-tenant app_config reader so the org-aware branding helpers
// can be driven deterministically (the real reader does two concurrent
// app_config lookups whose mock-queue order isn't guaranteed).
const getTenantConfigValueMock = vi.hoisted(() =>
  vi.fn(async (_orgId: string, _key: string): Promise<string | null> => null),
);
vi.mock("./app-config/store.js", () => ({
  getTenantConfigValue: getTenantConfigValueMock,
}));

// The `resupply.organizations` directory — where a self-serve tenant's
// signup name lands. Mocked so the "tenant with no dme_organization row"
// path is driven directly rather than through the shared response queue.
const resolveBrandingByOrgIdMock = vi.hoisted(() =>
  vi.fn(async (_orgId: string) => ({
    storefrontName: "CareMetric Breathe",
    legalName: "CareMetric Breathe",
    tagline: "The CPAP resupply platform for modern DME teams.",
    logoUrl: null as string | null,
  })),
);
const resolveTenantBaseUrlMock = vi.hoisted(() =>
  vi.fn(async (_orgId: string): Promise<string | null> => null),
);
vi.mock("./tenant-branding.js", () => ({
  resolveBrandingByOrgId: resolveBrandingByOrgIdMock,
  resolveTenantBaseUrl: resolveTenantBaseUrlMock,
}));

import {
  __resetCompanyInfoForTests,
  applyCompanyIdentityToText,
  getCompanyInfoSync,
  hydrateCompanyInfoCache,
  applyPlatformBranding,
  applyPlatformBrandingForOrg,
  brandToolDescriptors,
  formatPhoneForDisplay,
  getCompanyInfo,
  PLATFORM_NAME,
  resolveAssistantNamesForOrg,
} from "./company-info";

const ORG_ROW = {
  id: "org-1",
  singleton: true,
  legal_name: "Acme Home Medical LLC",
  dba_name: "Acme Sleep",
  organizational_npi: "1234567890",
  phone_e164: "+15551234567",
  fax_e164: null,
  billing_email: "billing@acme.example",
  general_email: "hello@acme.example",
  support_email: null,
  support_phone_e164: null,
  support_hours_text: "Mon–Sat 8a–6p CT",
  website_url: "https://www.acmesleep.example/",
  physical_address_line1: "1 Main St",
  physical_address_line2: null,
  physical_city: "Altoona",
  physical_state: "PA",
  physical_zip: "16601",
};

beforeEach(() => {
  supabaseMock.reset();
  __resetCompanyInfoForTests();
  getTenantConfigValueMock.mockReset();
  getTenantConfigValueMock.mockResolvedValue(null);
  resolveBrandingByOrgIdMock.mockReset();
  resolveBrandingByOrgIdMock.mockResolvedValue({
    storefrontName: "CareMetric Breathe",
    legalName: "CareMetric Breathe",
    tagline: "The CPAP resupply platform for modern DME teams.",
    logoUrl: null,
  });
  resolveTenantBaseUrlMock.mockReset();
  resolveTenantBaseUrlMock.mockResolvedValue(null);
});

afterEach(() => {
  delete process.env.RESUPPLY_PRACTICE_NAME;
  delete process.env.SENDGRID_FROM_NAME;
  delete process.env.RESUPPLY_ASSISTANT_STOREFRONT_NAME;
  delete process.env.RESUPPLY_ASSISTANT_ADMIN_NAME;
});

describe("assistant names + platform branding", () => {
  it("defaults the assistant names to the CareMetric platform names", async () => {
    stageSupabaseResponse("dme_organization", "select", { data: null });
    const info = await getCompanyInfo();
    expect(info.assistantStorefrontName).toBe("CareMetric Assistant");
    expect(info.assistantAdminName).toBe("CareMetric Copilot");
  });

  it("honors per-tenant assistant-name env overrides (the overlay path)", async () => {
    process.env.RESUPPLY_ASSISTANT_STOREFRONT_NAME = "PennBot";
    process.env.RESUPPLY_ASSISTANT_ADMIN_NAME = "PennPilot";
    stageSupabaseResponse("dme_organization", "select", { data: null });
    const info = await getCompanyInfo();
    expect(info.assistantStorefrontName).toBe("PennBot");
    expect(info.assistantAdminName).toBe("PennPilot");
  });

  it("applyPlatformBranding maps the Penn* placeholders to the defaults", async () => {
    stageSupabaseResponse("dme_organization", "select", { data: null });
    await getCompanyInfo(); // warm the sync cache
    const out = applyPlatformBranding(
      "PennFit ships PennBot on the storefront and PennPilot in the console.",
    );
    expect(out).toBe(
      `${PLATFORM_NAME} ships CareMetric Assistant on the storefront and CareMetric Copilot in the console.`,
    );
  });

  it("applyPlatformBranding is a no-op on assistant names for the Penn tenant", async () => {
    process.env.RESUPPLY_ASSISTANT_STOREFRONT_NAME = "PennBot";
    process.env.RESUPPLY_ASSISTANT_ADMIN_NAME = "PennPilot";
    stageSupabaseResponse("dme_organization", "select", { data: null });
    await getCompanyInfo();
    const out = applyPlatformBranding(
      "Ask PennBot or PennPilot about PennFit.",
    );
    // PennBot / PennPilot are unchanged (the tenant's configured names);
    // only the platform codename resolves to CareMetric Breathe.
    expect(out).toBe(`Ask PennBot or PennPilot about ${PLATFORM_NAME}.`);
  });
});

describe("per-tenant assistant branding (G3)", () => {
  it("resolveAssistantNamesForOrg defaults to the platform names when the tenant has no rows", async () => {
    getTenantConfigValueMock.mockResolvedValue(null);
    const names = await resolveAssistantNamesForOrg("org-acme");
    expect(names).toEqual({
      assistantStorefrontName: "CareMetric Assistant",
      assistantAdminName: "CareMetric Copilot",
    });
  });

  it("resolveAssistantNamesForOrg reads the tenant's configured names", async () => {
    getTenantConfigValueMock.mockImplementation(async (_orgId, key) =>
      key === "RESUPPLY_ASSISTANT_STOREFRONT_NAME"
        ? "Acme Assistant"
        : key === "RESUPPLY_ASSISTANT_ADMIN_NAME"
          ? "Acme Copilot"
          : null,
    );
    const names = await resolveAssistantNamesForOrg("org-acme");
    expect(names).toEqual({
      assistantStorefrontName: "Acme Assistant",
      assistantAdminName: "Acme Copilot",
    });
    // It reads the two tenant-scoped catalog keys for THIS org.
    expect(getTenantConfigValueMock).toHaveBeenCalledWith(
      "org-acme",
      "RESUPPLY_ASSISTANT_STOREFRONT_NAME",
    );
    expect(getTenantConfigValueMock).toHaveBeenCalledWith(
      "org-acme",
      "RESUPPLY_ASSISTANT_ADMIN_NAME",
    );
  });

  it("applyPlatformBrandingForOrg maps the Penn* tokens to the tenant's configured names", async () => {
    stageSupabaseResponse("dme_organization", "select", { data: null });
    await getCompanyInfo(); // warm the sync company-info cache
    getTenantConfigValueMock.mockImplementation(async (_orgId, key) =>
      key === "RESUPPLY_ASSISTANT_STOREFRONT_NAME"
        ? "Acme Assistant"
        : key === "RESUPPLY_ASSISTANT_ADMIN_NAME"
          ? "Acme Copilot"
          : null,
    );
    const out = await applyPlatformBrandingForOrg(
      "PennFit ships PennBot on the storefront and PennPilot in the console.",
      "org-acme",
    );
    expect(out).toBe(
      `${PLATFORM_NAME} ships Acme Assistant on the storefront and Acme Copilot in the console.`,
    );
  });

  it("applyPlatformBrandingForOrg degrades to the seed/default branding when orgId is absent", async () => {
    stageSupabaseResponse("dme_organization", "select", { data: null });
    await getCompanyInfo();
    const out = await applyPlatformBrandingForOrg(
      "Ask PennBot about PennFit.",
      undefined,
    );
    // No orgId → synchronous seed-scoped branding (CareMetric defaults).
    expect(out).toBe(`Ask CareMetric Assistant about ${PLATFORM_NAME}.`);
    expect(getTenantConfigValueMock).not.toHaveBeenCalled();
  });
});

describe("formatPhoneForDisplay", () => {
  it("formats NANP numbers", () => {
    expect(formatPhoneForDisplay("+18144710627")).toBe("(814) 471-0627");
  });
  it("passes non-NANP numbers through", () => {
    expect(formatPhoneForDisplay("+447911123456")).toBe("+447911123456");
  });
});

describe("getCompanyInfo", () => {
  it("resolves from the DB row, DBA name first, support falling back", async () => {
    stageSupabaseResponse("dme_organization", "select", { data: ORG_ROW });
    const info = await getCompanyInfo();
    expect(info.source).toBe("database");
    expect(info.name).toBe("Acme Sleep");
    expect(info.legalName).toBe("Acme Home Medical LLC");
    // support_phone/support_email unset → main phone / general email.
    expect(info.supportPhoneE164).toBe("+15551234567");
    expect(info.supportPhoneDisplay).toBe("(555) 123-4567");
    expect(info.supportEmail).toBe("hello@acme.example");
    expect(info.supportHours).toBe("Mon–Sat 8a–6p CT");
    expect(info.address?.city).toBe("Altoona");
  });

  it("falls back to RESUPPLY_PRACTICE_NAME when there is no row", async () => {
    process.env.RESUPPLY_PRACTICE_NAME = "Env Practice";
    stageSupabaseResponse("dme_organization", "select", { data: null });
    const info = await getCompanyInfo();
    expect(info.source).toBe("environment");
    expect(info.name).toBe("Env Practice");
    // Contact fields fall back to the neutral PLATFORM identity, not the
    // seed tenant's (PennPaps) — an unconfigured tenant must not inherit it.
    expect(info.supportEmail).toBe("support@cmbreathe.com");
  });

  it("loads assistant names from the tenant's app_config, not the seed env overlay", async () => {
    process.env.RESUPPLY_ASSISTANT_STOREFRONT_NAME = "PennBot";
    process.env.RESUPPLY_ASSISTANT_ADMIN_NAME = "PennPilot";
    getTenantConfigValueMock.mockImplementation(async (_orgId, key) =>
      key === "RESUPPLY_ASSISTANT_STOREFRONT_NAME"
        ? "Acme Assistant"
        : key === "RESUPPLY_ASSISTANT_ADMIN_NAME"
          ? "Acme Copilot"
          : null,
    );
    stageSupabaseResponse("dme_organization", "select", { data: ORG_ROW });
    const info = await getCompanyInfo("org-acme");
    expect(info.assistantStorefrontName).toBe("Acme Assistant");
    expect(info.assistantAdminName).toBe("Acme Copilot");
    expect(getTenantConfigValueMock).toHaveBeenCalledWith(
      "org-acme",
      "RESUPPLY_ASSISTANT_STOREFRONT_NAME",
    );
  });

  it("does not inherit seed env assistant names for a non-seed tenant with a DB row", async () => {
    process.env.RESUPPLY_ASSISTANT_STOREFRONT_NAME = "PennBot";
    process.env.RESUPPLY_ASSISTANT_ADMIN_NAME = "PennPilot";
    getTenantConfigValueMock.mockResolvedValue(null);
    stageSupabaseResponse("dme_organization", "select", { data: ORG_ROW });
    const info = await getCompanyInfo("org-acme");
    expect(info.assistantStorefrontName).toBe("CareMetric Assistant");
    expect(info.assistantAdminName).toBe("CareMetric Copilot");
  });

  it("degrades to the platform identity on a DB error", async () => {
    stageSupabaseResponse("dme_organization", "select", {
      error: { message: "boom" },
    });
    const info = await getCompanyInfo();
    expect(info.source).toBe("fallback");
    // CareMetric Breathe — the platform identity, NOT the seed tenant brand.
    expect(info.name).toBe("CareMetric Breathe");
    expect(info.supportPhoneDisplay).toBe("");
  });

  it("names a tenant that has not filled in Company Information from its signup name", async () => {
    // The naming rule: the software is CareMetric Breathe, the BUSINESS is
    // whatever its owner typed at signup. That name lands on the
    // `organizations` directory row, not on `dme_organization` — which only
    // /admin/company-information writes — so a brand-new tenant used to be
    // called "CareMetric Breathe" on its own storefront.
    resolveBrandingByOrgIdMock.mockResolvedValue({
      storefrontName: "Acme Sleep",
      legalName: "Acme Home Medical LLC",
      tagline: "t",
      logoUrl: null,
    });
    resolveTenantBaseUrlMock.mockResolvedValue("https://acme.example");
    stageSupabaseResponse("dme_organization", "select", { data: null });

    const info = await getCompanyInfo("org-acme");

    expect(info.name).toBe("Acme Sleep");
    expect(info.legalName).toBe("Acme Home Medical LLC");
    expect(info.websiteUrl).toBe("https://acme.example");
    // Only the NAME is known — contact details are still platform defaults,
    // and `source` stays "fallback" so the admin page keeps nudging them to
    // save real ones.
    expect(info.source).toBe("fallback");
    expect(info.supportEmail).toBe("support@cmbreathe.com");
    expect(info.supportPhoneDisplay).toBe("");
  });

  it("rewrites the baked-in placeholders to a signup-named tenant's own identity", async () => {
    resolveBrandingByOrgIdMock.mockResolvedValue({
      storefrontName: "Acme Sleep",
      legalName: "Acme Home Medical LLC",
      tagline: "t",
      logoUrl: null,
    });
    resolveTenantBaseUrlMock.mockResolvedValue("https://acme.example");
    stageSupabaseResponse("dme_organization", "select", { data: null });
    const info = await getCompanyInfo("org-acme");

    // Consent/notice bodies name the registered entity, so the legal name is
    // what replaces the in-source placeholder; the site becomes the tenant's.
    expect(
      applyCompanyIdentityToText(
        "Penn Home Medical Supply protects your health information. Visit pennpaps.com.",
        info,
      ),
    ).toBe(
      "Acme Home Medical LLC protects your health information. Visit acme.example.",
    );
  });

  it("still reaches the platform identity when the directory cannot name the tenant", async () => {
    // resolveBrandingByOrgId degrades to the platform brand on a miss or an
    // error, so an unnamed tenant is exactly as it was before.
    stageSupabaseResponse("dme_organization", "select", { data: null });
    const info = await getCompanyInfo("org-unknown");
    expect(info.name).toBe("CareMetric Breathe");
    expect(info.websiteUrl).toBe("https://cmbreathe.com");
  });

  it("does not read the org directory for the seed tenant", async () => {
    // The seed org row is created by the migrations carrying THIS repo's
    // tenant name, so reading it would hand an unrelated deployment the seed
    // tenant's brand — the exact leak the platform fallback prevents.
    stageSupabaseResponse("dme_organization", "select", { data: null });
    await getCompanyInfo();
    expect(resolveBrandingByOrgIdMock).not.toHaveBeenCalled();
  });
});

describe("hydrateCompanyInfoCache", () => {
  it("warms the sync cache from the row", async () => {
    stageSupabaseResponse("dme_organization", "select", { data: ORG_ROW });
    const result = await hydrateCompanyInfoCache();
    expect(result.applied).toBe(true);
    // The point of the hydration: the synchronous accessor now answers
    // without a DB round-trip.
    expect(getCompanyInfoSync().name).toBe("Acme Sleep");
  });

  it("reports not-applied when no row exists", async () => {
    stageSupabaseResponse("dme_organization", "select", { data: null });
    const result = await hydrateCompanyInfoCache();
    expect(result.applied).toBe(false);
  });

  it("writes NOTHING to process.env", async () => {
    // This is the regression the whole refactor exists to prevent. The old
    // applyCompanyInfoToEnv folded the SEED tenant's name into
    // RESUPPLY_PRACTICE_NAME (and aliased SENDGRID_FROM_NAME to it), so one
    // process-global carried one tenant's brand to every other tenant's
    // SMS, email, voice prompt, PDF header and MFA issuer.
    delete process.env.RESUPPLY_PRACTICE_NAME;
    delete process.env.SENDGRID_FROM_NAME;
    stageSupabaseResponse("dme_organization", "select", { data: ORG_ROW });
    await hydrateCompanyInfoCache();
    expect(process.env.RESUPPLY_PRACTICE_NAME).toBeUndefined();
    expect(process.env.SENDGRID_FROM_NAME).toBeUndefined();
  });
});

describe("applyCompanyIdentityToText", () => {
  it("is a no-op for an env-configured deployment (source=environment)", async () => {
    // A single-tenant / env-configured deployment: the baked-in default text
    // already reflects the deployment's own identity, so the rewrite is a
    // deliberate no-op.
    process.env.RESUPPLY_PRACTICE_NAME = "Env Practice";
    stageSupabaseResponse("dme_organization", "select", { data: null });
    await getCompanyInfo(); // warm the sync cache → source=environment
    const text = "Call (814) 471-0627 or email support@pennpaps.com";
    expect(applyCompanyIdentityToText(text)).toBe(text);
  });

  it("rewrites the Penn placeholders to the platform identity for an unconfigured (fallback) tenant", async () => {
    // No env practice name + no row → the neutral CareMetric platform
    // identity. The historical Penn placeholders MUST be rewritten (not left
    // to leak the seed contact to another tenant): brand/email/site to the
    // platform's, and the phone — which the platform doesn't have — removed.
    stageSupabaseResponse("dme_organization", "select", { data: null });
    const info = await getCompanyInfo();
    expect(info.source).toBe("fallback");
    const out = applyCompanyIdentityToText(
      "Call (814) 471-0627 or email support@pennpaps.com or visit pennpaps.com — PennPaps",
    );
    expect(out).not.toContain("pennpaps.com");
    expect(out).not.toContain("(814) 471-0627"); // platform has no phone
    expect(out).not.toContain("PennPaps");
    expect(out).toContain("support@cmbreathe.com");
    expect(out).toContain("cmbreathe.com");
    expect(out).toContain("CareMetric Breathe");
  });

  it("rewrites the historical brand/contact strings from the row", async () => {
    stageSupabaseResponse("dme_organization", "select", { data: ORG_ROW });
    await getCompanyInfo(); // warm the sync cache
    const out = applyCompanyIdentityToText(
      "PennBot is PennPaps's assistant on PennPaps.com — call " +
        "(814) 471-0627 (Mon-Fri 9-5 ET) or email support@pennpaps.com / " +
        "info@pennpaps.com.",
    );
    expect(out).toContain("Acme Sleep's assistant");
    expect(out).toContain("acmesleep.example");
    expect(out).toContain("(555) 123-4567");
    expect(out).toContain("Mon–Sat 8a–6p CT");
    expect(out).toContain("hello@acme.example");
    expect(out).not.toContain("PennPaps");
    expect(out).not.toContain("(814) 471-0627");
  });

  it("rewrites the TTS-spaced brand spelling used in voice/IVR copy", async () => {
    stageSupabaseResponse("dme_organization", "select", { data: ORG_ROW });
    await getCompanyInfo(); // warm the sync cache
    const out = applyCompanyIdentityToText(
      "Hi, this is an automated check-in from Penn Paps.",
    );
    expect(out).toBe("Hi, this is an automated check-in from Acme Sleep.");
    expect(out).not.toContain("Penn Paps");
  });

  it("rewrites the legacy TTS spelling for the seed tenant, which no longer has a DBA", async () => {
    // Migration 0510 retired the seed tenant's "PennPaps" storefront DBA, so
    // its row resolves name === legalName === "Penn Home Medical Supply".
    // The spaced-spelling needle used to be suppressed for that tenant to
    // protect a deliberate two-word TTS pronunciation; with the DBA gone
    // there is nothing to protect, and any voice copy still carrying the
    // old spelling must resolve to the official company name.
    stageSupabaseResponse("dme_organization", "select", {
      data: {
        ...ORG_ROW,
        legal_name: "Penn Home Medical Supply",
        dba_name: null,
      },
    });
    const info = await getCompanyInfo(); // warm the sync cache
    expect(info.name).toBe("Penn Home Medical Supply");
    expect(info.name).toBe(info.legalName);
    const out = applyCompanyIdentityToText(
      "Hi, this is an automated check-in from Penn Paps.",
    );
    expect(out).toBe(
      "Hi, this is an automated check-in from Penn Home Medical Supply.",
    );
    expect(out).not.toContain("Penn Paps");
  });
});

describe("brandToolDescriptors", () => {
  it("rewrites Penn placeholders in the function description and nested parameter descriptions", async () => {
    stageSupabaseResponse("dme_organization", "select", { data: ORG_ROW });
    const info = await getCompanyInfo();
    const branded = brandToolDescriptors(
      [
        {
          type: "function" as const,
          function: {
            name: "recommend_masks",
            description:
              "Recommend the best PennPaps masks. PennBot should cite (814) 471-0627.",
            parameters: {
              type: "object",
              properties: {
                order_reference: {
                  type: "string",
                  description:
                    "The PennPaps order reference, e.g. 'PENN-AB1234'.",
                },
              },
            },
          },
        },
      ],
      info,
    );
    const desc = branded[0]?.function.description ?? "";
    expect(desc).toContain("Acme Sleep");
    expect(desc).toContain("CareMetric Assistant");
    expect(desc).toContain("(555) 123-4567");
    expect(desc).not.toContain("PennPaps");
    expect(desc).not.toContain("PennBot");
    expect(desc).not.toContain("(814) 471-0627");
    const paramDesc =
      (
        branded[0]?.function.parameters as {
          properties: { order_reference: { description: string } };
        }
      ).properties.order_reference.description ?? "";
    expect(paramDesc).toContain("Acme Sleep");
    expect(paramDesc).not.toContain("PennPaps");
  });
});

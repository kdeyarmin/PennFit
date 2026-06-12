// company-info resolver: the central "what is this company called and
// how do patients reach it" answer.
//
//   1. DB row wins: dba_name (else legal_name) becomes the display
//      name; support fields fall back to the main phone / emails.
//   2. No DB row → RESUPPLY_PRACTICE_NAME env → hardcoded defaults.
//   3. A DB error degrades to env + defaults (fail-soft, never throws).
//   4. applyCompanyInfoToEnv hydrates RESUPPLY_PRACTICE_NAME and the
//      SENDGRID_FROM_NAME alias only when the row exists.
//   5. applyCompanyIdentityToText rewrites the historical hardcoded
//      strings only once the DB row exists.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  __resetCompanyInfoForTests,
  applyCompanyIdentityToText,
  applyCompanyInfoToEnv,
  formatPhoneForDisplay,
  getCompanyInfo,
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
});

afterEach(() => {
  delete process.env.RESUPPLY_PRACTICE_NAME;
  delete process.env.SENDGRID_FROM_NAME;
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
    expect(info.supportEmail).toBe("support@pennpaps.com");
  });

  it("degrades to the hardcoded defaults on a DB error", async () => {
    stageSupabaseResponse("dme_organization", "select", {
      error: { message: "boom" },
    });
    const info = await getCompanyInfo();
    expect(info.source).toBe("fallback");
    expect(info.name).toBe("PennPaps");
    expect(info.supportPhoneDisplay).toBe("(814) 471-0627");
  });
});

describe("applyCompanyInfoToEnv", () => {
  it("hydrates RESUPPLY_PRACTICE_NAME and SENDGRID_FROM_NAME from the row", async () => {
    stageSupabaseResponse("dme_organization", "select", { data: ORG_ROW });
    const result = await applyCompanyInfoToEnv();
    expect(result.applied).toBe(true);
    expect(process.env.RESUPPLY_PRACTICE_NAME).toBe("Acme Sleep");
    expect(process.env.SENDGRID_FROM_NAME).toBe("Acme Sleep");
  });

  it("does not touch env when no row exists", async () => {
    stageSupabaseResponse("dme_organization", "select", { data: null });
    const result = await applyCompanyInfoToEnv();
    expect(result.applied).toBe(false);
    expect(process.env.RESUPPLY_PRACTICE_NAME).toBeUndefined();
  });
});

describe("applyCompanyIdentityToText", () => {
  it("is a no-op until the org row exists", async () => {
    stageSupabaseResponse("dme_organization", "select", { data: null });
    await getCompanyInfo();
    const text = "Call (814) 471-0627 or email support@pennpaps.com";
    expect(applyCompanyIdentityToText(text)).toBe(text);
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
});

// Behavioral tests for the storefront company-identity fetch.
// Prefers /api/storefront-company-info and falls back to
// /api/company-info when the alias is missing (rolling deploy).

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TENANT_BODY = {
  name: "Acme DME",
  legalName: "Acme DME LLC",
  phoneE164: "+18005551212",
  phoneDisplay: "(800) 555-1212",
  supportEmail: "support@acme.example",
  generalEmail: "info@acme.example",
  websiteUrl: "https://acme.example",
  supportHours: "Mon–Fri 9–5",
  assistantStorefrontName: "AcmeBot",
  assistantAdminName: "AcmePilot",
};

describe("getCompanyContact fetch", () => {
  it("loads identity from /api/storefront-company-info when available", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("storefront-company-info")) {
        return jsonResponse(TENANT_BODY);
      }
      return jsonResponse({ error: "not_found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getCompanyContact } = await import("./contact");
    getCompanyContact();

    await vi.waitFor(() => {
      expect(getCompanyContact().name).toBe("Acme DME");
    });
    expect(getCompanyContact().email).toBe("support@acme.example");
    expect(getCompanyContact().assistantStorefrontName).toBe("AcmeBot");
    expect(
      fetchMock.mock.calls.some((c) =>
        String(c[0]).includes("storefront-company-info"),
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some((c) =>
        String(c[0]).endsWith("/api/company-info"),
      ),
    ).toBe(false);
  });

  it("falls back to /api/company-info when the storefront alias 404s", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("storefront-company-info")) {
        return jsonResponse({ error: "not_found" }, 404);
      }
      if (
        url.endsWith("/api/company-info") ||
        url.includes("/api/company-info")
      ) {
        return jsonResponse(TENANT_BODY);
      }
      return jsonResponse({ error: "not_found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getCompanyContact } = await import("./contact");
    getCompanyContact();

    await vi.waitFor(() => {
      expect(getCompanyContact().name).toBe("Acme DME");
    });
    expect(
      fetchMock.mock.calls.some((c) =>
        String(c[0]).includes("storefront-company-info"),
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some((c) =>
        String(c[0]).includes("/api/company-info"),
      ),
    ).toBe(true);
  });

  it("keeps CareMetric compile-time defaults when both endpoints fail", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi.fn(async () => jsonResponse({ error: "down" }, 503));
    vi.stubGlobal("fetch", fetchMock);

    const { getCompanyContact, DEFAULT_COMPANY_CONTACT } =
      await import("./contact");
    expect(getCompanyContact().name).toBe(DEFAULT_COMPANY_CONTACT.name);
    expect(DEFAULT_COMPANY_CONTACT.name).toBe("CareMetric Breathe");

    await Promise.resolve();
    await Promise.resolve();
    expect(getCompanyContact().name).toBe("CareMetric Breathe");
  });
});

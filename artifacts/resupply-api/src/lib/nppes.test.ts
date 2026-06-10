// Unit tests for the NPPES lookup helper.
//
// All network is mocked via the `fetchImpl` injection point — these
// must stay deterministic in CI (the real registry sits behind a
// CDN/WAF whose behavior varies by egress IP, which is exactly the
// failure mode the error-classification below exists to diagnose).

import { describe, expect, it, vi } from "vitest";

import {
  lookupNpi,
  nppesFailurePublicMessage,
  NppesLookupError,
} from "./nppes";

const NPI = "1003000126";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const REGISTERED = {
  result_count: 1,
  results: [
    {
      number: NPI,
      basic: {
        first_name: "ARDALAN",
        last_name: "ENKESHAFI",
        credential: "M.D.",
      },
      addresses: [
        {
          address_purpose: "MAILING",
          address_1: "PO BOX 1",
          city: "BETHESDA",
          state: "MD",
          postal_code: "20817",
          country_code: "US",
          telephone_number: "443-602-6207",
        },
        {
          address_purpose: "LOCATION",
          address_1: "6410 ROCKLEDGE DR STE 304",
          city: "BETHESDA",
          state: "MD",
          postal_code: "208171841",
          country_code: "US",
          telephone_number: "443-602-6207",
          fax_number: "540-224-5684",
        },
      ],
      taxonomies: [
        { code: "208M00000X", desc: "Hospitalist", primary: true },
        { code: "207R00000X", desc: "Internal Medicine", primary: false },
      ],
    },
  ],
};

describe("lookupNpi", () => {
  it("projects a registered individual NPI (LOCATION address, primary taxonomy, E.164)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(REGISTERED));
    const out = await lookupNpi(NPI, { fetchImpl });
    expect(out).toEqual({
      npi: NPI,
      legalName: "ARDALAN ENKESHAFI, M.D.",
      taxonomyCode: "208M00000X",
      phoneE164: "+14436026207",
      faxE164: "+15402245684",
      practiceName: null,
      practiceAddress: {
        line1: "6410 ROCKLEDGE DR STE 304",
        line2: undefined,
        city: "BETHESDA",
        state: "MD",
        postalCode: "208171841",
        country: "US",
      },
    });
  });

  it("prefers organization_name for org NPIs", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        result_count: 1,
        results: [
          {
            number: NPI,
            basic: { organization_name: "PENN SLEEP CLINIC LLC" },
          },
        ],
      }),
    );
    const out = await lookupNpi(NPI, { fetchImpl });
    expect(out?.legalName).toBe("PENN SLEEP CLINIC LLC");
    expect(out?.practiceName).toBe("PENN SLEEP CLINIC LLC");
  });

  it("sends an identifying User-Agent and Accept header (undici sends none by default)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(REGISTERED));
    await lookupNpi(NPI, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      `https://npiregistry.cms.hhs.gov/api/?version=2.1&number=${NPI}`,
    );
    expect(init.headers).toMatchObject({
      accept: "application/json",
      "user-agent": expect.stringContaining("PennFit"),
    });
  });

  it("returns null for an unregistered NPI", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ result_count: 0, results: [] }));
    await expect(lookupNpi(NPI, { fetchImpl })).resolves.toBeNull();
  });

  it("rejects a malformed NPI before any network call", async () => {
    const fetchImpl = vi.fn();
    await expect(lookupNpi("12345", { fetchImpl })).rejects.toMatchObject({
      name: "NppesLookupError",
      kind: "invalid_npi",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("classifies a non-2xx upstream as kind=http with the status attached", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 403));
    await expect(lookupNpi(NPI, { fetchImpl })).rejects.toMatchObject({
      name: "NppesLookupError",
      kind: "http",
      upstreamStatus: 403,
    });
  });

  it("classifies a fetch rejection as kind=network", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(lookupNpi(NPI, { fetchImpl })).rejects.toMatchObject({
      name: "NppesLookupError",
      kind: "network",
    });
  });

  it("classifies an abort-by-timeout as kind=timeout", async () => {
    // Behave like undici: reject with AbortError when the signal fires.
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(
              new DOMException("This operation was aborted", "AbortError"),
            ),
          );
        }),
    );
    await expect(
      lookupNpi(NPI, { fetchImpl: fetchImpl as typeof fetch, timeoutMs: 10 }),
    ).rejects.toMatchObject({
      name: "NppesLookupError",
      kind: "timeout",
    });
  });

  it("classifies a non-JSON body as kind=parse", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("<html>WAF block page</html>"));
    await expect(lookupNpi(NPI, { fetchImpl })).rejects.toMatchObject({
      name: "NppesLookupError",
      kind: "parse",
    });
  });
});

describe("nppesFailurePublicMessage", () => {
  it("includes the upstream HTTP status for kind=http", () => {
    const msg = nppesFailurePublicMessage(
      new NppesLookupError("x", { kind: "http", upstreamStatus: 403 }),
    );
    expect(msg).toContain("HTTP 403");
    expect(msg).toContain("manually");
  });

  it("never leaks internals for network failures", () => {
    const msg = nppesFailurePublicMessage(
      new NppesLookupError("getaddrinfo ENOTFOUND", {
        kind: "network",
        cause: new Error("ECONNRESET 10.0.0.1"),
      }),
    );
    expect(msg).not.toContain("ENOTFOUND");
    expect(msg).not.toContain("10.0.0.1");
  });
});

// Unit tests for the tenant custom-domain helpers: input normalization,
// the DNS TXT ownership challenge, and the operator DNS instructions.

import { afterEach, describe, expect, it } from "vitest";

import {
  buildDomainInstructions,
  DOMAIN_VERIFY_TXT_HOST,
  domainVerifyTxtValue,
  extractTenantSubdomainLabel,
  generateDomainToken,
  isPlatformSubdomainOrigin,
  normalizeCustomDomain,
  verifyDomainTxt,
} from "./tenant-domain";

describe("normalizeCustomDomain", () => {
  it("lowercases and trims a plain hostname", () => {
    expect(normalizeCustomDomain("  Shop.Acme-DME.com ")).toBe(
      "shop.acme-dme.com",
    );
  });

  it("strips a pasted scheme, path, port, and trailing dot", () => {
    expect(normalizeCustomDomain("https://shop.acme.com:443/foo?x=1")).toBe(
      "shop.acme.com",
    );
    expect(normalizeCustomDomain("shop.acme.com.")).toBe("shop.acme.com");
  });

  it("drops a leading www.", () => {
    expect(normalizeCustomDomain("www.acme.com")).toBe("acme.com");
  });

  it("rejects single labels, IPs, and platform hosts", () => {
    expect(normalizeCustomDomain("localhost")).toBeNull();
    expect(normalizeCustomDomain("acme")).toBeNull();
    expect(normalizeCustomDomain("192.168.0.1")).toBeNull();
    expect(normalizeCustomDomain("foo.up.railway.app")).toBeNull();
    expect(normalizeCustomDomain("cmbreathe.com")).toBeNull();
    expect(normalizeCustomDomain("www.cmbreathe.com")).toBeNull();
    expect(normalizeCustomDomain("")).toBeNull();
    expect(normalizeCustomDomain("-bad.com")).toBeNull();
    expect(normalizeCustomDomain("bad-.com")).toBeNull();
  });

  it("accepts apex and multi-level subdomains", () => {
    expect(normalizeCustomDomain("acme.com")).toBe("acme.com");
    expect(normalizeCustomDomain("store.shop.acme.co.uk")).toBe(
      "store.shop.acme.co.uk",
    );
  });
});

describe("generateDomainToken", () => {
  it("produces distinct url-safe tokens", () => {
    const a = generateDomainToken();
    const b = generateDomainToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(24);
  });
});

describe("buildDomainInstructions", () => {
  const prev = process.env.PENNFIT_CUSTOM_DOMAIN_CNAME_TARGET;
  const prevRailwayPublicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  afterEach(() => {
    if (prev === undefined)
      delete process.env.PENNFIT_CUSTOM_DOMAIN_CNAME_TARGET;
    else process.env.PENNFIT_CUSTOM_DOMAIN_CNAME_TARGET = prev;

    if (prevRailwayPublicDomain === undefined)
      delete process.env.RAILWAY_PUBLIC_DOMAIN;
    else process.env.RAILWAY_PUBLIC_DOMAIN = prevRailwayPublicDomain;
  });

  it("builds the default CNAME target, TXT name under the verify label, and embeds the token", () => {
    delete process.env.PENNFIT_CUSTOM_DOMAIN_CNAME_TARGET;
    delete process.env.RAILWAY_PUBLIC_DOMAIN;
    const ins = buildDomainInstructions("shop.acme.com", "tok123");
    expect(ins.cnameTarget).toBe("cmbreathe.com");
    expect(ins.txtName).toBe(`${DOMAIN_VERIFY_TXT_HOST}.shop.acme.com`);
    expect(ins.txtValue).toBe(domainVerifyTxtValue("tok123"));
    expect(ins.txtValue).toContain("tok123");
  });

  it("honors the CNAME-target override", () => {
    process.env.PENNFIT_CUSTOM_DOMAIN_CNAME_TARGET = "ingress.pennfit.app";
    expect(buildDomainInstructions("shop.acme.com", "t").cnameTarget).toBe(
      "ingress.pennfit.app",
    );
  });
});

describe("verifyDomainTxt", () => {
  it("returns true when a TXT record matches the expected value", async () => {
    const token = "abc";
    const resolver = async () => [["pennfit-domain-verification=abc"]];
    expect(await verifyDomainTxt("acme.com", token, resolver)).toBe(true);
  });

  it("joins chunked TXT strings before comparing", async () => {
    const token = "abc";
    const resolver = async () => [["pennfit-domain-verification=", "abc"]];
    expect(await verifyDomainTxt("acme.com", token, resolver)).toBe(true);
  });

  it("returns false when no record matches", async () => {
    const resolver = async () => [["something-else"]];
    expect(await verifyDomainTxt("acme.com", "abc", resolver)).toBe(false);
  });

  it("fails soft to false on a DNS error (NXDOMAIN, no record yet)", async () => {
    const resolver = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await verifyDomainTxt("acme.com", "abc", resolver)).toBe(false);
  });

  it("queries the verify label under the domain", async () => {
    let queried = "";
    const resolver = async (host: string) => {
      queried = host;
      return [["nope"]];
    };
    await verifyDomainTxt("acme.com", "abc", resolver);
    expect(queried).toBe(`${DOMAIN_VERIFY_TXT_HOST}.acme.com`);
  });
});

describe("extractTenantSubdomainLabel (G10 subdomain routing)", () => {
  const original = process.env.PLATFORM_SUBDOMAIN_BASES;
  afterEach(() => {
    if (original === undefined) delete process.env.PLATFORM_SUBDOMAIN_BASES;
    else process.env.PLATFORM_SUBDOMAIN_BASES = original;
  });

  it("returns the slug label for <slug>.<base> on the default base", () => {
    delete process.env.PLATFORM_SUBDOMAIN_BASES; // default cmbreathe.com
    expect(extractTenantSubdomainLabel("acme.cmbreathe.com")).toBe("acme");
  });

  it("is case-insensitive and tolerates a port / trailing dot", () => {
    expect(extractTenantSubdomainLabel("Acme.CmBreathe.com:443")).toBe("acme");
    expect(extractTenantSubdomainLabel("acme.cmbreathe.com.")).toBe("acme");
  });

  it("returns null for the apex itself", () => {
    expect(extractTenantSubdomainLabel("cmbreathe.com")).toBeNull();
  });

  it("returns null for a multi-level subdomain", () => {
    expect(extractTenantSubdomainLabel("a.b.cmbreathe.com")).toBeNull();
  });

  it("returns null for reserved labels (www, app, api, …)", () => {
    expect(extractTenantSubdomainLabel("www.cmbreathe.com")).toBeNull();
    expect(extractTenantSubdomainLabel("api.cmbreathe.com")).toBeNull();
    expect(extractTenantSubdomainLabel("app.cmbreathe.com")).toBeNull();
  });

  it("returns null for a host not under any configured base", () => {
    expect(extractTenantSubdomainLabel("acme.example.com")).toBeNull();
    expect(extractTenantSubdomainLabel("pennfit.up.railway.app")).toBeNull();
  });

  it("honors a custom PLATFORM_SUBDOMAIN_BASES list", () => {
    process.env.PLATFORM_SUBDOMAIN_BASES = "caremetric.ai, cmbreathe.com";
    expect(extractTenantSubdomainLabel("acme.caremetric.ai")).toBe("acme");
    expect(extractTenantSubdomainLabel("acme.cmbreathe.com")).toBe("acme");
  });

  it("rejects a malformed slug label", () => {
    expect(extractTenantSubdomainLabel("-bad.cmbreathe.com")).toBeNull();
    expect(extractTenantSubdomainLabel("bad-.cmbreathe.com")).toBeNull();
  });
});

describe("isPlatformSubdomainOrigin (G10 CORS)", () => {
  const original = process.env.PLATFORM_SUBDOMAIN_BASES;
  afterEach(() => {
    if (original === undefined) delete process.env.PLATFORM_SUBDOMAIN_BASES;
    else process.env.PLATFORM_SUBDOMAIN_BASES = original;
  });

  it("accepts an https origin on a platform subdomain", () => {
    delete process.env.PLATFORM_SUBDOMAIN_BASES;
    expect(isPlatformSubdomainOrigin("https://acme.cmbreathe.com")).toBe(true);
  });

  it("rejects the apex, a non-base host, and a non-URL string", () => {
    expect(isPlatformSubdomainOrigin("https://cmbreathe.com")).toBe(false);
    expect(isPlatformSubdomainOrigin("https://acme.example.com")).toBe(false);
    expect(isPlatformSubdomainOrigin("not a url")).toBe(false);
    expect(isPlatformSubdomainOrigin("")).toBe(false);
  });
});

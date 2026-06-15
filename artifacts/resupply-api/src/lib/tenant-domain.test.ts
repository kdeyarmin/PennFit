// Unit tests for the tenant custom-domain helpers: input normalization,
// the DNS TXT ownership challenge, and the operator DNS instructions.

import { afterEach, describe, expect, it } from "vitest";

import {
  buildDomainInstructions,
  DOMAIN_VERIFY_TXT_HOST,
  domainVerifyTxtValue,
  generateDomainToken,
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
  afterEach(() => {
    if (prev === undefined)
      delete process.env.PENNFIT_CUSTOM_DOMAIN_CNAME_TARGET;
    else process.env.PENNFIT_CUSTOM_DOMAIN_CNAME_TARGET = prev;
  });

  it("builds the TXT name under the verify label and embeds the token", () => {
    const ins = buildDomainInstructions("shop.acme.com", "tok123");
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

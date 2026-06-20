import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkSendgridDomainAuth, emailDomain } from "./sendgrid-domain-auth";

describe("emailDomain", () => {
  it("extracts and lowercases the domain", () => {
    expect(emailDomain("Info@Example.COM")).toBe("example.com");
  });
  it("returns null when there's no @", () => {
    expect(emailDomain("not-an-email")).toBeNull();
  });
});

describe("checkSendgridDomainAuth", () => {
  beforeEach(() => {
    delete process.env.SENDGRID_API_KEY;
  });
  afterEach(() => {
    delete process.env.SENDGRID_API_KEY;
  });

  it("returns unknown when no address is set", async () => {
    const r = await checkSendgridDomainAuth(null, { apiKey: "SG.x" });
    expect(r.status).toBe("unknown");
  });

  it("returns unknown when SendGrid isn't configured", async () => {
    const r = await checkSendgridDomainAuth("info@acme.com");
    expect(r.status).toBe("unknown");
    expect(r.detail).toMatch(/SendGrid isn't configured/);
  });

  it("reports authenticated on an exact valid domain match", async () => {
    const r = await checkSendgridDomainAuth("info@acme.com", {
      apiKey: "SG.x",
      fetchDomains: async () => [{ domain: "acme.com", valid: true }],
    });
    expect(r.status).toBe("authenticated");
    expect(r.matchedDomain).toBe("acme.com");
  });

  it("treats a root authentication as covering a subdomain address", async () => {
    const r = await checkSendgridDomainAuth("billing@mail.acme.com", {
      apiKey: "SG.x",
      fetchDomains: async () => [{ domain: "acme.com", valid: true }],
    });
    expect(r.status).toBe("authenticated");
  });

  it("reports unauthenticated when the matching domain is not valid", async () => {
    const r = await checkSendgridDomainAuth("info@acme.com", {
      apiKey: "SG.x",
      fetchDomains: async () => [{ domain: "acme.com", valid: false }],
    });
    expect(r.status).toBe("unauthenticated");
  });

  it("reports unauthenticated when no domain matches", async () => {
    const r = await checkSendgridDomainAuth("info@acme.com", {
      apiKey: "SG.x",
      fetchDomains: async () => [{ domain: "other.com", valid: true }],
    });
    expect(r.status).toBe("unauthenticated");
  });

  it("fails soft to unknown when the SendGrid call throws", async () => {
    const r = await checkSendgridDomainAuth("info@acme.com", {
      apiKey: "SG.x",
      fetchDomains: async () => {
        throw new Error("network");
      },
    });
    expect(r.status).toBe("unknown");
  });

  it("does not falsely match a domain that merely ends with the same string", async () => {
    // "notacme.com" must NOT be covered by an authentication for "acme.com".
    const r = await checkSendgridDomainAuth("info@notacme.com", {
      apiKey: "SG.x",
      fetchDomains: async () => [{ domain: "acme.com", valid: true }],
    });
    expect(r.status).toBe("unauthenticated");
  });
});

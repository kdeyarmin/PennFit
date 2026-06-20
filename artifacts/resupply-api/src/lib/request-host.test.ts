// requestHost: proxy-aware, lowercased, port-stripped host extraction.

import { describe, it, expect } from "vitest";

import { requestHost } from "./request-host";

function req(headers: Record<string, string | string[] | undefined>) {
  return { headers } as Parameters<typeof requestHost>[0];
}

describe("requestHost", () => {
  it("prefers X-Forwarded-Host over Host", () => {
    expect(
      requestHost(req({ "x-forwarded-host": "shop.acme.com", host: "api" })),
    ).toBe("shop.acme.com");
  });

  it("falls back to Host when no forwarded host", () => {
    expect(requestHost(req({ host: "Shop.Acme.COM" }))).toBe("shop.acme.com");
  });

  it("takes the first value of a comma list / array", () => {
    expect(requestHost(req({ "x-forwarded-host": "a.com, b.com" }))).toBe(
      "a.com",
    );
    expect(requestHost(req({ "x-forwarded-host": ["a.com", "b.com"] }))).toBe(
      "a.com",
    );
  });

  it("strips a :port suffix (so example.com:443 == example.com)", () => {
    expect(requestHost(req({ host: "example.com:443" }))).toBe("example.com");
    expect(requestHost(req({ host: "shop.acme.com:8080" }))).toBe(
      "shop.acme.com",
    );
  });

  it("leaves an IPv6 literal intact, stripping only its port", () => {
    expect(requestHost(req({ host: "[::1]:443" }))).toBe("[::1]");
    expect(requestHost(req({ host: "[2001:db8::1]" }))).toBe("[2001:db8::1]");
  });

  it("returns '' when no host header is present", () => {
    expect(requestHost(req({}))).toBe("");
  });
});

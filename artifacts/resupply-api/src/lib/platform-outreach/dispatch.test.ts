// Tests for the platform outreach body assembly + URL builder.

import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/resupply-secrets", () => ({
  getLinkHmacKey: () =>
    Buffer.from("test-dispatch-hmac-key-0123456789", "utf8"),
}));

import {
  buildOutreachBody,
  customArgsFor,
  platformPublicBaseUrl,
  unsubscribeUrlForContact,
} from "./dispatch";

describe("buildOutreachBody", () => {
  it("appends a one-click unsubscribe link when present", () => {
    const out = buildOutreachBody({
      bodyHtml: "<p>Hi</p>",
      bodyText: "Hi",
      unsubscribeUrl: "https://x.test/u?t=abc",
    });
    expect(out.text).toContain("https://x.test/u?t=abc");
    expect(out.html).toContain('href="https://x.test/u?t=abc"');
    expect(out.html).toContain("<p>Hi</p>");
  });

  it("falls back to a reply-to-opt-out note without a link", () => {
    const out = buildOutreachBody({
      bodyHtml: null,
      bodyText: "Hi",
      unsubscribeUrl: null,
    });
    expect(out.text).toContain("UNSUBSCRIBE");
    expect(out.html).toContain("UNSUBSCRIBE");
    // bodyHtml null → text wrapped in <p>.
    expect(out.html).toContain("<p>Hi</p>");
  });

  it("escapes HTML when synthesizing a body from plain text", () => {
    const out = buildOutreachBody({
      bodyHtml: null,
      bodyText: "<script>alert(1)</script>",
      unsubscribeUrl: null,
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
  });
});

describe("customArgsFor", () => {
  it("carries the campaign + recipient ids for webhook correlation", () => {
    expect(customArgsFor("camp-1", "rec-2")).toEqual({
      platform_email_campaign_id: "camp-1",
      platform_email_recipient_id: "rec-2",
    });
  });
});

describe("unsubscribeUrlForContact", () => {
  it("returns null without a contact id or base url", () => {
    expect(unsubscribeUrlForContact(null, "https://x.test")).toBeNull();
    expect(unsubscribeUrlForContact("c1", "")).toBeNull();
  });

  it("builds an absolute API unsubscribe link for a contact", () => {
    const url = unsubscribeUrlForContact("c1", "https://x.test");
    expect(url).toContain(
      "https://x.test/resupply-api/platform-unsubscribe?t=",
    );
  });
});

describe("platformPublicBaseUrl", () => {
  it("prefers REMINDER_PUBLIC_BASE_URL and strips a trailing slash", () => {
    expect(
      platformPublicBaseUrl({ REMINDER_PUBLIC_BASE_URL: "https://x.test/" }),
    ).toBe("https://x.test");
  });

  it("derives from RAILWAY_PUBLIC_DOMAIN when no explicit url", () => {
    expect(platformPublicBaseUrl({ RAILWAY_PUBLIC_DOMAIN: "y.test" })).toBe(
      "https://y.test",
    );
  });

  it("is empty when nothing is set", () => {
    expect(platformPublicBaseUrl({})).toBe("");
  });
});

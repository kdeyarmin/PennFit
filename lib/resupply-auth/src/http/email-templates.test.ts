import { describe, expect, it } from "vitest";

import {
  formatTokenExpiry,
  renderPasswordResetEmail,
  renderVerifyEmail,
} from "./email-templates";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("formatTokenExpiry", () => {
  it("renders whole hours up to 47h", () => {
    expect(formatTokenExpiry(HOUR_MS)).toBe("1 hour");
    expect(formatTokenExpiry(2 * HOUR_MS)).toBe("2 hours");
    expect(formatTokenExpiry(24 * HOUR_MS)).toBe("24 hours");
  });

  it("rolls up to whole days at >= 48h", () => {
    expect(formatTokenExpiry(2 * DAY_MS)).toBe("2 days");
    expect(formatTokenExpiry(7 * DAY_MS)).toBe("7 days");
  });

  it("falls back to minutes for sub-hour or non-round values", () => {
    expect(formatTokenExpiry(60_000)).toBe("1 minute");
    expect(formatTokenExpiry(90 * 60 * 1000)).toBe("90 minutes");
  });
});

describe("renderVerifyEmail", () => {
  const ctx = {
    productName: "TestProduct",
    publicBaseUrl: "https://shop.example.com",
  };

  it("includes the verify URL with the token URL-encoded", () => {
    const r = renderVerifyEmail(ctx, "abc-token", DAY_MS);
    expect(r.subject).toContain("TestProduct");
    expect(r.html).toContain(
      "https://shop.example.com/verify-email?token=abc-token",
    );
    expect(r.text).toContain(
      "https://shop.example.com/verify-email?token=abc-token",
    );
  });

  it("renders the expiry derived from the TTL", () => {
    expect(renderVerifyEmail(ctx, "t", DAY_MS).html).toContain(
      "expires in 24 hours",
    );
    expect(renderVerifyEmail(ctx, "t", 2 * HOUR_MS).text).toContain(
      "expires in 2 hours",
    );
  });

  it("prepends uiPathPrefix when supplied (admin mount)", () => {
    const r = renderVerifyEmail(
      { ...ctx, uiPathPrefix: "/admin" },
      "abc-token",
      DAY_MS,
    );
    expect(r.html).toContain(
      "https://shop.example.com/admin/verify-email?token=abc-token",
    );
    expect(r.text).toContain(
      "https://shop.example.com/admin/verify-email?token=abc-token",
    );
    expect(r.html).not.toContain("https://shop.example.com/verify-email");
  });

  it("strips trailing slashes from uiPathPrefix", () => {
    const r = renderVerifyEmail(
      { ...ctx, uiPathPrefix: "/admin/" },
      "tok",
      DAY_MS,
    );
    expect(r.html).toContain("https://shop.example.com/admin/verify-email");
  });

  it("escapes HTML in the product name", () => {
    const r = renderVerifyEmail(
      { productName: "<script>", publicBaseUrl: "https://x.test" },
      "t",
      DAY_MS,
    );
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;");
  });
});

describe("renderPasswordResetEmail", () => {
  const ctx = {
    productName: "TestProduct",
    publicBaseUrl: "https://shop.example.com",
  };

  it("includes the reset URL", () => {
    const r = renderPasswordResetEmail(ctx, "tok123", HOUR_MS);
    expect(r.subject).toContain("Reset your TestProduct password");
    expect(r.html).toContain(
      "https://shop.example.com/reset-password?token=tok123",
    );
    expect(r.text).toContain(
      "https://shop.example.com/reset-password?token=tok123",
    );
  });

  it("renders the expiry derived from the TTL (not a hardcoded value)", () => {
    // Regression guard: the copy used to be hardcoded "1 hour" while the
    // forgot-password flow runs on a 24h token and team-invite on 7 days.
    const resetEmail = renderPasswordResetEmail(ctx, "t", 24 * HOUR_MS);
    expect(resetEmail.html).toContain("expires in 24 hours");
    expect(resetEmail.text).toContain("expires in 24 hours");

    const inviteEmail = renderPasswordResetEmail(ctx, "t", 7 * DAY_MS);
    expect(inviteEmail.html).toContain("expires in 7 days");
    expect(inviteEmail.text).toContain("expires in 7 days");
  });

  it("uses uiPathPrefix for admin mount", () => {
    const r = renderPasswordResetEmail(
      { ...ctx, uiPathPrefix: "/admin" },
      "tok123",
      HOUR_MS,
    );
    expect(r.html).toContain(
      "https://shop.example.com/admin/reset-password?token=tok123",
    );
    expect(r.text).toContain(
      "https://shop.example.com/admin/reset-password?token=tok123",
    );
  });
});

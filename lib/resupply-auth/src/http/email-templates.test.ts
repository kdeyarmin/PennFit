import { describe, expect, it } from "vitest";

import {
  formatTokenExpiry,
  renderPasswordResetEmail,
  renderProviderPortalInviteEmail,
  renderTeamInviteEmail,
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

describe("renderTeamInviteEmail", () => {
  const ctx = {
    productName: "TestProduct",
    publicBaseUrl: "https://shop.example.com",
    uiPathPrefix: "/admin",
  };
  const args = {
    rawToken: "tok123",
    ttlMs: 7 * DAY_MS,
    email: "jane@example.com",
    displayName: "Jane Smith",
    roleLabel: "Customer service rep",
    attachmentFilenames: ["Guide-One.pdf", "Guide-Two.pdf"],
  };

  it("is a welcome email, not a password reset", () => {
    const r = renderTeamInviteEmail(ctx, args);
    expect(r.subject).toBe(
      "Welcome to the TestProduct team — set up your account",
    );
    expect(r.html).not.toMatch(/reset your/i);
    expect(r.text).not.toMatch(/request to reset/i);
    expect(r.html).toContain("You've been invited to join");
    expect(r.text).toContain("You've been invited to join");
  });

  it("greets by first name and explains what the app is", () => {
    const r = renderTeamInviteEmail(ctx, args);
    expect(r.html).toContain("Hi Jane,");
    expect(r.text).toContain("Hi Jane,");
    expect(r.text).toContain("CPAP resupply");
  });

  it("falls back to a neutral greeting without a display name", () => {
    const r = renderTeamInviteEmail(ctx, { ...args, displayName: null });
    expect(r.html).toContain("Hello,");
    expect(r.text).toContain("Hello,");
  });

  it("includes the username, role label, and sign-in page", () => {
    const r = renderTeamInviteEmail(ctx, args);
    expect(r.html).toContain("jane@example.com");
    expect(r.html).toContain("Customer service rep");
    expect(r.html).toContain("https://shop.example.com/admin/sign-in");
    expect(r.text).toContain("Username (your sign-in email): jane@example.com");
    expect(r.text).toContain("Role: Customer service rep");
    expect(r.text).toContain("https://shop.example.com/admin/sign-in");
  });

  it("omits the role line when no label is supplied", () => {
    const r = renderTeamInviteEmail(ctx, { ...args, roleLabel: null });
    expect(r.html).not.toContain("Role:");
    expect(r.text).not.toContain("Role:");
  });

  it("links the set-password step with the expiry derived from the TTL", () => {
    const r = renderTeamInviteEmail(ctx, args);
    expect(r.html).toContain(
      "https://shop.example.com/admin/reset-password?token=tok123",
    );
    expect(r.text).toContain(
      "https://shop.example.com/admin/reset-password?token=tok123",
    );
    expect(r.html).toContain("expires in 7 days");
    expect(r.text).toContain("expires in 7 days");

    const bootstrap = renderTeamInviteEmail(ctx, { ...args, ttlMs: HOUR_MS });
    expect(bootstrap.text).toContain("expires in 1 hour");
  });

  it("lists the attached getting-started guides by filename", () => {
    const r = renderTeamInviteEmail(ctx, args);
    expect(r.html).toContain("getting-started guides");
    expect(r.html).toContain("Guide-One.pdf");
    expect(r.html).toContain("Guide-Two.pdf");
    expect(r.text).toContain("Guide-One.pdf");
    expect(r.text).toContain("Guide-Two.pdf");
  });

  it("uses the singular noun for a single attached guide", () => {
    const r = renderTeamInviteEmail(ctx, {
      ...args,
      attachmentFilenames: ["Guide-One.pdf"],
    });
    expect(r.text).toContain("getting-started guide for your role");
    expect(r.text).not.toContain("guides");
  });

  it("omits the attachments section when there are none", () => {
    const r = renderTeamInviteEmail(ctx, {
      ...args,
      attachmentFilenames: [],
    });
    expect(r.html).not.toContain("attached");
    expect(r.text).not.toContain("attached");
  });

  it("escapes HTML in the display name, role label, and filenames", () => {
    const r = renderTeamInviteEmail(ctx, {
      ...args,
      displayName: "<b>Eve</b>",
      roleLabel: "<script>",
      attachmentFilenames: ["<img>.pdf"],
    });
    expect(r.html).not.toContain("<b>Eve</b>");
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("<img>");
    expect(r.html).toContain("&lt;script&gt;");
  });
});

describe("renderProviderPortalInviteEmail", () => {
  const ctx = {
    productName: "PennFit Provider Portal",
    publicBaseUrl: "https://shop.example.com",
  };
  const args = {
    rawToken: "tok123",
    ttlMs: 7 * DAY_MS,
    email: "dr.jones@clinic.example.com",
    providerName: "Dr. Casey Jones",
    practiceName: "Penn Home Medical Supply",
    portalPath: "/provider",
    attachmentFilenames: ["PennPaps-Provider-Portal-Guide.pdf"],
  };

  it("is an invitation, not a password reset", () => {
    const r = renderProviderPortalInviteEmail(ctx, args);
    expect(r.subject).toBe("You're invited to the PennFit Provider Portal");
    expect(r.html).not.toMatch(/reset your/i);
    expect(r.text).not.toMatch(/request to reset/i);
  });

  it("greets the provider by full name and names the inviting practice", () => {
    const r = renderProviderPortalInviteEmail(ctx, args);
    expect(r.html).toContain("Hello Dr. Casey Jones,");
    expect(r.text).toContain("Hello Dr. Casey Jones,");
    expect(r.text).toContain("Penn Home Medical Supply has invited you");
  });

  it("explains the e-sign purpose and includes the username", () => {
    const r = renderProviderPortalInviteEmail(ctx, args);
    expect(r.text).toContain("electronically sign documents");
    expect(r.text).toContain(
      "Your username is your email address: dr.jones@clinic.example.com",
    );
  });

  it("links set-password with TTL-derived expiry and the portal sign-in", () => {
    const r = renderProviderPortalInviteEmail(ctx, args);
    expect(r.html).toContain(
      "https://shop.example.com/reset-password?token=tok123",
    );
    expect(r.text).toContain("expires in 7 days");
    expect(r.html).toContain("https://shop.example.com/provider");
    expect(r.text).toContain("https://shop.example.com/provider");
  });

  it("lists attached guides and tolerates absent optional fields", () => {
    const r = renderProviderPortalInviteEmail(ctx, args);
    expect(r.text).toContain("PennPaps-Provider-Portal-Guide.pdf");

    const minimal = renderProviderPortalInviteEmail(ctx, {
      rawToken: "t",
      ttlMs: 7 * DAY_MS,
      email: "a@b.test",
    });
    expect(minimal.html).toContain("Hello,");
    expect(minimal.text).toContain("You've been invited");
    expect(minimal.html).not.toContain("sign in any time");
    expect(minimal.html).not.toContain("attached");
  });

  it("escapes HTML in the provider and practice names", () => {
    const r = renderProviderPortalInviteEmail(ctx, {
      ...args,
      providerName: "<i>Dr</i>",
      practiceName: "<b>Practice</b>",
    });
    expect(r.html).not.toContain("<i>Dr</i>");
    expect(r.html).not.toContain("<b>Practice</b>");
    expect(r.html).toContain("&lt;i&gt;Dr&lt;/i&gt;");
  });
});

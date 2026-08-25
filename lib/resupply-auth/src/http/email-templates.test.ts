import { describe, expect, it } from "vitest";

import {
  formatTokenExpiry,
  renderPasswordResetEmail,
  renderPatientPortalInviteEmail,
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

describe("renderPatientPortalInviteEmail", () => {
  const ctx = {
    productName: "Penn Home Medical Supply",
    publicBaseUrl: "https://shop.example.com",
  };
  const args = {
    rawToken: "tok123",
    ttlMs: 7 * DAY_MS,
    patientFirstName: "Pat Q",
    attachmentFilenames: ["Penn Home Medical Supply-Patient-Portal-Guide.pdf"],
  };

  it("greets by first name and links the set-password step", () => {
    const r = renderPatientPortalInviteEmail(ctx, args);
    expect(r.subject).toBe(
      "Set up your Penn Home Medical Supply patient portal",
    );
    expect(r.html).toContain("Hi Pat,");
    expect(r.text).toContain("Hi Pat,");
    expect(r.html).toContain(
      "https://shop.example.com/reset-password?token=tok123",
    );
    expect(r.text).toContain(
      "https://shop.example.com/reset-password?token=tok123",
    );
  });

  it("derives the expiry from the TTL instead of hardcoding 7 days", () => {
    expect(renderPatientPortalInviteEmail(ctx, args).text).toContain(
      "expires in 7 days",
    );
    expect(
      renderPatientPortalInviteEmail(ctx, { ...args, ttlMs: 2 * DAY_MS }).text,
    ).toContain("expires in 2 days");
  });

  it("lists the attached guide and omits the section when absent", () => {
    const r = renderPatientPortalInviteEmail(ctx, args);
    expect(r.html).toContain(
      "Penn Home Medical Supply-Patient-Portal-Guide.pdf",
    );
    expect(r.text).toContain("getting-started guide");

    const none = renderPatientPortalInviteEmail(ctx, {
      ...args,
      attachmentFilenames: [],
    });
    expect(none.html).not.toContain("attached");
    expect(none.text).not.toContain("attached");
  });

  it("keeps HTML entities out of the plain-text greeting", () => {
    const r = renderPatientPortalInviteEmail(ctx, {
      ...args,
      patientFirstName: "O'Brien",
    });
    expect(r.text).toContain("Hi O'Brien,");
    expect(r.text).not.toContain("&#39;");
    expect(r.html).toContain("Hi O&#39;Brien,");
  });

  it("falls back to a neutral greeting for missing or blank names", () => {
    const r = renderPatientPortalInviteEmail(ctx, {
      ...args,
      patientFirstName: "   ",
    });
    expect(r.html).toContain("Hello,");
    expect(r.text).toContain("Hello,");
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
    roleSummary:
      "You are the patient's first point of contact — messages, orders, scheduling, and day-to-day service.",
    roleHighlights: [
      "Work the inbox: patient texts, emails, and calls.",
      "Fulfil and ship orders, print labels, and handle returns.",
    ],
    attachments: [
      {
        filename: "Guide-One.pdf",
        description: "Start here — activating your account.",
      },
      { filename: "Guide-Two.pdf", description: "Your job in detail." },
    ],
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

  it("names the admin who sent the invitation, and who to ask", () => {
    const r = renderTeamInviteEmail(ctx, {
      ...args,
      invitedByName: "Dana Ruiz",
    });
    expect(r.html).toContain("Dana Ruiz has invited you to join");
    expect(r.text).toContain("Dana Ruiz has invited you to join");
    // …and the closing "who to ask" line names the same person.
    expect(r.text).toContain("ask Dana Ruiz or your supervisor");
  });

  it("falls back to neutral phrasing when the inviter is unknown", () => {
    const r = renderTeamInviteEmail(ctx, { ...args, invitedByName: null });
    expect(r.text).toContain("You've been invited to join");
    expect(r.text).toContain("ask the administrator who invited you");
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

  // The point of the section: a new hire should learn what their JOB is
  // from the email itself, not only from an attachment they may not open.
  it("explains what the role is responsible for, day to day", () => {
    const r = renderTeamInviteEmail(ctx, args);
    expect(r.text).toContain("Your role");
    expect(r.text).toContain(
      "As a Customer service rep, you are the patient's first point of contact",
    );
    expect(r.text).toContain(
      "Work the inbox: patient texts, emails, and calls.",
    );
    expect(r.html).toContain("Fulfil and ship orders");
  });

  it("agrees the article with the role label", () => {
    // "As a Owner" is the kind of thing a new hire notices on the first
    // email the software ever sends them.
    const owner = renderTeamInviteEmail(ctx, {
      ...args,
      roleLabel: "Owner",
      roleSummary: "You have full access to the workspace.",
    });
    expect(owner.text).toContain("As an Owner, you have full access");
    expect(owner.text).not.toContain("As a Owner");
    expect(owner.html).toContain("As an <strong>Owner</strong>");
  });

  it("omits the role section when the caller supplies no role copy", () => {
    const r = renderTeamInviteEmail(ctx, {
      ...args,
      roleSummary: null,
      roleHighlights: [],
    });
    expect(r.text).not.toContain("Your role");
    expect(r.html).not.toContain("Your role");
  });

  it("walks the numbered getting-started steps, MFA included", () => {
    const r = renderTeamInviteEmail(ctx, args);
    expect(r.text).toContain("Getting started");
    expect(r.text).toContain("1. Choose your password");
    expect(r.text).toContain(
      "2. Sign in at https://shop.example.com/admin/sign-in",
    );
    expect(r.text).toContain("3. Turn on multi-factor authentication");
    expect(r.text).toContain("4. Open Support in the console");
    expect(r.text).toContain("protected health information");
    expect(r.html).toContain("multi-factor authentication");
    expect(r.html).toContain("User Manual");
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

  it("lists each attached document with what it is for", () => {
    const r = renderTeamInviteEmail(ctx, args);
    expect(r.html).toContain("documents for your role");
    expect(r.html).toContain("Guide-One.pdf");
    expect(r.html).toContain("Start here — activating your account.");
    expect(r.text).toContain("Guide-Two.pdf — Your job in detail.");
  });

  it("uses the singular noun for a single attached document", () => {
    const r = renderTeamInviteEmail(ctx, {
      ...args,
      attachments: [{ filename: "Guide-One.pdf" }],
    });
    expect(r.text).toContain("the document for your role");
    expect(r.text).not.toContain("documents for your role");
    // No description supplied → the filename stands alone, no dangling dash.
    expect(r.text).toContain("  * Guide-One.pdf\n");
  });

  it("omits the attachments section when there are none", () => {
    const r = renderTeamInviteEmail(ctx, {
      ...args,
      attachments: [],
    });
    expect(r.html).not.toContain("attached");
    expect(r.text).not.toContain("attached");
  });

  it("escapes HTML in the display name, role label, filenames, and role copy", () => {
    const r = renderTeamInviteEmail(ctx, {
      ...args,
      displayName: "<b>Eve</b>",
      roleLabel: "<script>",
      invitedByName: "<u>Mal</u>",
      roleSummary: "<em>owns</em> the queue",
      roleHighlights: ["<i>bullet</i>"],
      attachments: [{ filename: "<img>.pdf", description: "<svg>" }],
    });
    expect(r.html).not.toContain("<b>Eve</b>");
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("<img>");
    expect(r.html).not.toContain("<u>Mal</u>");
    expect(r.html).not.toContain("<i>bullet</i>");
    expect(r.html).not.toContain("<svg>");
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
    attachmentFilenames: ["Penn Home Medical Supply-Provider-Portal-Guide.pdf"],
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
    expect(r.text).toContain(
      "Penn Home Medical Supply-Provider-Portal-Guide.pdf",
    );

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

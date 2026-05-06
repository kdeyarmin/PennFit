import { describe, expect, it } from "vitest";

import { renderPasswordResetEmail, renderVerifyEmail } from "./email-templates";

describe("renderVerifyEmail", () => {
  const ctx = {
    productName: "TestProduct",
    publicBaseUrl: "https://shop.example.com",
  };

  it("includes the verify URL with the token URL-encoded", () => {
    const r = renderVerifyEmail(ctx, "abc-token");
    expect(r.subject).toContain("TestProduct");
    expect(r.html).toContain(
      "https://shop.example.com/verify-email?token=abc-token",
    );
    expect(r.text).toContain(
      "https://shop.example.com/verify-email?token=abc-token",
    );
  });

  it("prepends uiPathPrefix when supplied (admin mount)", () => {
    const r = renderVerifyEmail(
      { ...ctx, uiPathPrefix: "/admin" },
      "abc-token",
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
    const r = renderVerifyEmail({ ...ctx, uiPathPrefix: "/admin/" }, "tok");
    expect(r.html).toContain("https://shop.example.com/admin/verify-email");
  });

  it("escapes HTML in the product name", () => {
    const r = renderVerifyEmail(
      { productName: "<script>", publicBaseUrl: "https://x.test" },
      "t",
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
    const r = renderPasswordResetEmail(ctx, "tok123");
    expect(r.subject).toContain("Reset your TestProduct password");
    expect(r.html).toContain(
      "https://shop.example.com/reset-password?token=tok123",
    );
    expect(r.text).toContain(
      "https://shop.example.com/reset-password?token=tok123",
    );
  });

  it("uses uiPathPrefix for admin mount", () => {
    const r = renderPasswordResetEmail(
      { ...ctx, uiPathPrefix: "/admin" },
      "tok123",
    );
    expect(r.html).toContain(
      "https://shop.example.com/admin/reset-password?token=tok123",
    );
    expect(r.text).toContain(
      "https://shop.example.com/admin/reset-password?token=tok123",
    );
  });
});

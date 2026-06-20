import { describe, expect, it } from "vitest";

import {
  brandedButton,
  paragraph,
  renderBrandedEmail,
  textParagraph,
} from "./layout";

describe("renderBrandedEmail", () => {
  it("wraps content and defaults the wordmark to the platform brand", () => {
    const html = renderBrandedEmail({
      contentHtml: paragraph("Hello world."),
    });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Hello world.");
    expect(html).toContain("CareMetric Breathe");
    // Copyright line is appended automatically.
    expect(html).toContain("All rights reserved.");
  });

  it("uses the caller's brand name in the header and copyright (escaped)", () => {
    const html = renderBrandedEmail({
      brandName: "PennPaps",
      contentHtml: paragraph("Hi"),
    });
    expect(html).toContain("PennPaps");
    expect(html).not.toContain("CareMetric Breathe");
  });

  it("escapes HTML in the brand name", () => {
    const html = renderBrandedEmail({
      brandName: "<script>",
      contentHtml: paragraph("Hi"),
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders an optional heading and preheader", () => {
    const html = renderBrandedEmail({
      heading: "Welcome aboard",
      preheader: "A quick hello",
      contentHtml: paragraph("Body"),
    });
    expect(html).toContain("Welcome aboard");
    expect(html).toContain("A quick hello");
  });

  it("renders a CTA button with the destination URL", () => {
    const html = renderBrandedEmail({
      contentHtml: paragraph("Body"),
      button: { label: "Verify email", url: "https://x.test/verify?token=abc" },
    });
    expect(html).toContain("https://x.test/verify?token=abc");
    expect(html).toContain("Verify email");
    // Outlook VML fallback present.
    expect(html).toContain("v:roundrect");
  });

  it("renders footer lines and an explicit copyright override", () => {
    const html = renderBrandedEmail({
      contentHtml: paragraph("Body"),
      footerLines: ["Penn Home Medical Supply", "123 Main St"],
      copyrightName: "Penn Home Medical Supply",
    });
    expect(html).toContain("123 Main St");
    expect(html).toContain("© ");
    expect(html).toContain("Penn Home Medical Supply");
  });

  it("omits the copyright line when copyrightName is empty", () => {
    const html = renderBrandedEmail({
      contentHtml: paragraph("Body"),
      copyrightName: "",
    });
    expect(html).not.toContain("All rights reserved.");
  });
});

describe("paragraph / textParagraph", () => {
  it("injects inner HTML verbatim in paragraph()", () => {
    expect(paragraph('<a href="x">link</a>')).toContain('<a href="x">link</a>');
  });

  it("escapes plain text in textParagraph()", () => {
    const p = textParagraph("a < b & c");
    expect(p).toContain("a &lt; b &amp; c");
  });
});

describe("brandedButton", () => {
  it("includes both the MSO fallback and the anchor", () => {
    const btn = brandedButton("Go", "https://x.test/go");
    expect(btn).toContain("v:roundrect");
    expect(btn).toContain('<a href="https://x.test/go"');
    expect(btn).toContain("Go");
  });
});

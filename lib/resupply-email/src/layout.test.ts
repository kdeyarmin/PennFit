import { describe, expect, it } from "vitest";

import {
  brandedButton,
  bulletList,
  divider,
  escapeHtml,
  infoPanel,
  lineItemsTable,
  paragraph,
  renderBrandedEmail,
  secondaryLink,
  subheading,
  summaryRows,
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
      brandName: "Penn Home Medical Supply",
      contentHtml: paragraph("Hi"),
    });
    expect(html).toContain("Penn Home Medical Supply");
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

describe("escapeHtml", () => {
  it("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<a href="x">O'Neil & co</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;O&#39;Neil &amp; co&lt;/a&gt;",
    );
  });
});

describe("lineItemsTable", () => {
  it("renders name, optional detail, and amount (all escaped)", () => {
    const html = lineItemsTable([
      {
        name: "ResMed AirFit F20",
        detail: "Size: Medium",
        amount: "2 × $45.00",
      },
    ]);
    expect(html).toContain("ResMed AirFit F20");
    expect(html).toContain("Size: Medium");
    expect(html).toContain("2 × $45.00");
  });

  it("escapes item values", () => {
    const html = lineItemsTable([{ name: "<script>alert(1)</script>" }]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("returns an empty string for no items", () => {
    expect(lineItemsTable([])).toBe("");
  });
});

describe("summaryRows", () => {
  it("renders label/value pairs and bolds the emphasis row", () => {
    const html = summaryRows([
      { label: "Subtotal", value: "$90.00" },
      { label: "Total", value: "$95.00", emphasis: true },
    ]);
    expect(html).toContain("Subtotal");
    expect(html).toContain("$95.00");
    expect(html).toContain("font-weight:700");
  });

  it("returns an empty string for no rows", () => {
    expect(summaryRows([])).toBe("");
  });
});

describe("infoPanel", () => {
  it("renders a titled panel and injects body HTML verbatim", () => {
    const html = infoPanel({
      title: "Shipping to",
      html: "100 Main St<br/>Philadelphia, PA",
    });
    expect(html).toContain("Shipping to");
    expect(html).toContain("100 Main St<br/>Philadelphia, PA");
  });

  it("varies the background by tone", () => {
    const warn = infoPanel({ html: "x", tone: "warning" });
    const ok = infoPanel({ html: "x", tone: "success" });
    expect(warn).not.toBe(ok);
    expect(warn).toContain("#fff7e8");
    expect(ok).toContain("#eefbf4");
  });

  it("escapes the title", () => {
    expect(infoPanel({ title: "<b>hi</b>", html: "x" })).toContain(
      "&lt;b&gt;hi&lt;/b&gt;",
    );
  });
});

describe("bulletList", () => {
  it("escapes items and returns empty for no items", () => {
    expect(bulletList(["a & b"])).toContain("a &amp; b");
    expect(bulletList([])).toBe("");
  });
});

describe("secondaryLink / subheading / divider", () => {
  it("renders an escaped, underlined secondary link", () => {
    const html = secondaryLink("or browse the shop", "https://x.test/shop");
    expect(html).toContain("https://x.test/shop");
    expect(html).toContain("or browse the shop");
    expect(html).toContain("text-decoration:underline");
  });

  it("escapes the subheading text", () => {
    expect(subheading("Ship & bill")).toContain("Ship &amp; bill");
  });

  it("renders a hairline rule", () => {
    expect(divider()).toContain("height:1px");
  });
});

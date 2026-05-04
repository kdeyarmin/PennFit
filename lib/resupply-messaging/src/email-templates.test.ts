import { describe, expect, it } from "vitest";

import {
  escapeHtml,
  renderClickConfirmation,
  renderClickError,
  renderResupplyReminder,
} from "./email-templates";

describe("escapeHtml", () => {
  it("escapes the five canonical characters", () => {
    expect(escapeHtml("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("leaves safe text untouched", () => {
    expect(escapeHtml("Hello world 123")).toBe("Hello world 123");
  });
});

describe("renderResupplyReminder", () => {
  const base = {
    practiceName: "Penn Sleep Center",
    firstName: "Alex",
    items: [
      { name: "Nasal pillows mask", quantity: 1 },
      { name: "Pillow cushions, medium", quantity: 4 },
    ],
    confirmUrl: "https://api.example/email/click?t=conf",
    editUrl: "https://api.example/email/click?t=edit",
    stopUrl: "https://api.example/email/click?t=stop",
  } as const;

  it("returns subject + html + text", () => {
    const out = renderResupplyReminder(base);
    expect(out.subject).toBe("Time to refill your CPAP supplies");
    expect(out.html).toContain("Penn Sleep Center");
    expect(out.text).toContain("Penn Sleep Center");
  });

  it("does not include PHI (first name) in the subject", () => {
    const out = renderResupplyReminder(base);
    expect(out.subject).not.toContain("Alex");
  });

  it("escapes HTML-special characters in interpolated names", () => {
    const out = renderResupplyReminder({
      ...base,
      firstName: "<script>alert(1)</script>",
      practiceName: 'Penn "Sleep" & Wellness',
    });
    expect(out.html).not.toContain("<script>alert(1)");
    expect(out.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out.html).toContain("&quot;Sleep&quot;");
    expect(out.html).toContain("&amp;");
  });

  it("includes each item in HTML and text bodies", () => {
    const out = renderResupplyReminder(base);
    expect(out.text).toContain("Nasal pillows mask × 1");
    expect(out.text).toContain("Pillow cushions, medium × 4");
    expect(out.html).toContain("Nasal pillows mask");
    expect(out.html).toContain("Pillow cushions, medium");
  });

  it("falls back to a generic line when items is empty", () => {
    const out = renderResupplyReminder({ ...base, items: [] });
    expect(out.text).toContain("(your supplies, per your prescription)");
    expect(out.html).toContain("Your supplies, per your prescription.");
  });

  it("places confirm/edit/stop URLs verbatim into href attributes", () => {
    const out = renderResupplyReminder(base);
    expect(out.html).toContain(`href="${base.confirmUrl}"`);
    expect(out.html).toContain(`href="${base.editUrl}"`);
    expect(out.html).toContain(`href="${base.stopUrl}"`);
    expect(out.text).toContain(base.confirmUrl);
    expect(out.text).toContain(base.editUrl);
    expect(out.text).toContain(base.stopUrl);
  });
});

describe("renderClickConfirmation", () => {
  it("renders a confirm-success page without PHI", () => {
    const html = renderClickConfirmation({
      practiceName: "Penn Sleep Center",
      action: "confirm",
    });
    expect(html).toContain("Order confirmed");
    expect(html).toContain("Penn Sleep Center");
    expect(html).toContain("on its way");
  });

  it("renders an edit-redirect page", () => {
    const html = renderClickConfirmation({
      practiceName: "Penn Sleep Center",
      action: "edit",
    });
    // Apostrophes are HTML-escaped to &#39; — assert on the unambiguous
    // surrounding text ("be in touch") instead of the apostrophe itself.
    expect(html).toContain("be in touch");
    expect(html).toContain("address change");
  });

  it("renders an unsubscribe page", () => {
    const html = renderClickConfirmation({
      practiceName: "Penn Sleep Center",
      action: "stop",
    });
    expect(html).toContain("Reminders paused");
    expect(html).toContain("unsubscribed");
  });

  it("escapes practice name", () => {
    const html = renderClickConfirmation({
      practiceName: "<b>Penn</b>",
      action: "confirm",
    });
    expect(html).not.toContain("<b>Penn</b>");
    expect(html).toContain("&lt;b&gt;Penn&lt;/b&gt;");
  });
});

describe("renderClickError", () => {
  it.each([
    ["malformed", "is no longer valid"],
    ["bad-signature", "is no longer valid"],
    ["expired", "expired"],
    ["unknown-action", "is no longer valid"],
  ] as const)("renders a generic error for reason=%s", (reason, expected) => {
    const html = renderClickError({
      practiceName: "Penn Sleep Center",
      reason,
    });
    expect(html).toContain(expected);
  });

  it("does NOT echo the failure reason verbatim (no leak)", () => {
    const html = renderClickError({
      practiceName: "Penn Sleep Center",
      reason: "bad-signature",
    });
    expect(html).not.toContain("bad-signature");
  });
});

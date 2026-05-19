import { describe, expect, it } from "vitest";

import {
  escapeHtml,
  renderClickConfirmation,
  renderClickError,
  renderClickLanding,
  renderResupplyReminder,
} from "./email-templates";

describe("escapeHtml", () => {
  it("escapes the five canonical characters", () => {
    expect(escapeHtml("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("leaves safe text untouched", () => {
    expect(escapeHtml("Hello world 123")).toBe("Hello world 123");
  });

  // PR change: escapeHtml is now documented as safe for double-quoted
  // attribute values (href/src/action). Verify that `"` and `&` are
  // encoded so an attacker-controlled string cannot break out of an
  // HTML attribute or corrupt query parameters.
  it("encodes double-quotes so an attacker cannot break out of an attribute value", () => {
    // Input that would close the attribute and inject onclick if not escaped.
    const malicious = '"onmouseover="alert(1)"';
    const result = escapeHtml(malicious);
    expect(result).not.toContain('"onmouseover=');
    expect(result).toContain("&quot;onmouseover=&quot;alert(1)&quot;");
  });

  it("encodes & in a URL query string to &amp; (safe for href attribute context)", () => {
    const url = "https://example.com/click?t=abc&s=xyz";
    expect(escapeHtml(url)).toBe("https://example.com/click?t=abc&amp;s=xyz");
  });

  it("is idempotent on already-safe strings (no double-encoding of non-special chars)", () => {
    const safe = "https://example.com/path?key=value";
    expect(escapeHtml(safe)).toBe(safe);
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

  // PR change: URLs that contain `&` in query parameters must now be
  // escaped to `&amp;` inside href attributes (HTML spec requirement).
  // The plain-text body must NOT be HTML-escaped (entity literals in
  // a plain-text email would confuse the recipient).
  it("encodes & in URL query params as &amp; in href attributes but NOT in plain text", () => {
    const urlWithAmpersand = "https://api.example/email/click?t=abc&s=xyz&v=1";
    const out = renderResupplyReminder({
      ...base,
      confirmUrl: urlWithAmpersand,
    });
    // HTML body: & must be &amp; inside the href value.
    expect(out.html).toContain('href="https://api.example/email/click?t=abc&amp;s=xyz&amp;v=1"');
    // HTML body: must NOT contain the raw & in the href context.
    expect(out.html).not.toContain(`href="${urlWithAmpersand}"`);
    // Plain-text body: raw URL is preserved exactly so email clients
    // render a clickable link and recipients can copy it.
    expect(out.text).toContain(urlWithAmpersand);
    expect(out.text).not.toContain("&amp;");
  });

  it("escapes a URL containing a double-quote to prevent href injection", () => {
    // An attacker-controlled URL with a literal `"` would close the href
    // attribute and allow injecting additional attributes. escapeHtml
    // must encode it as &quot; so the attribute boundary is maintained.
    const maliciousUrl =
      'https://api.example/click?t=conf" onmouseover="alert(1)';
    const out = renderResupplyReminder({
      ...base,
      confirmUrl: maliciousUrl,
    });
    // The raw unescaped URL with literal quotes MUST NOT appear inside
    // the href — otherwise the attacker breaks out of the attribute.
    expect(out.html).not.toContain(`href="${maliciousUrl}"`);
    // The literal `"` from the payload must be entity-encoded so the
    // attacker can't terminate the attribute. This is the load-bearing
    // assertion. (Note: the text `onmouseover=` itself can still appear
    // as plain text INSIDE the encoded href value — it's harmless there
    // because the surrounding `&quot;` prevents the browser from parsing
    // it as a real attribute.)
    expect(out.html).toContain(
      'href="https://api.example/click?t=conf&quot; onmouseover=&quot;alert(1)"',
    );
  });
});

// PR change: renderClickLanding now also escapes the formActionUrl via
// escapeHtml so a URL with `&` is valid inside the form action attribute.
describe("renderClickLanding", () => {
  it("renders a confirm landing page with the correct heading", () => {
    const html = renderClickLanding({
      practiceName: "Penn Sleep Center",
      action: "confirm",
      formActionUrl: "https://api.example/email/click?t=conf",
    });
    expect(html).toContain("Confirm your CPAP resupply order");
    expect(html).toContain("Penn Sleep Center");
    expect(html).toContain("Confirm my order");
  });

  it("renders a stop-reminders landing page", () => {
    const html = renderClickLanding({
      practiceName: "Penn Sleep Center",
      action: "stop",
      formActionUrl: "https://api.example/email/click?t=stop",
    });
    expect(html).toContain("Stop CPAP refill reminders");
    expect(html).toContain("Stop reminders");
  });

  // PR change: formActionUrl is now passed through escapeHtml so `&`
  // in the form action attribute is encoded to &amp;.
  it("encodes & in formActionUrl query params as &amp; in the form action attribute", () => {
    const urlWithAmp = "https://api.example/email/click?t=conf&v=2";
    const html = renderClickLanding({
      practiceName: "Penn Sleep Center",
      action: "confirm",
      formActionUrl: urlWithAmp,
    });
    expect(html).toContain('action="https://api.example/email/click?t=conf&amp;v=2"');
    expect(html).not.toContain(`action="${urlWithAmp}"`);
  });

  it("escapes double-quotes in formActionUrl to prevent form action attribute injection", () => {
    const maliciousUrl = 'https://api.example/click?t=conf" method="GET';
    const html = renderClickLanding({
      practiceName: "Penn Sleep Center",
      action: "confirm",
      formActionUrl: maliciousUrl,
    });
    // The injected method override must NOT survive.
    expect(html).not.toContain(`action="${maliciousUrl}"`);
    expect(html).toContain("&quot;");
  });

  it("escapes practice name in landing page to prevent XSS", () => {
    const html = renderClickLanding({
      practiceName: '<script>alert("xss")</script>',
      action: "edit",
      formActionUrl: "https://api.example/email/click?t=edit",
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain("&lt;script&gt;");
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

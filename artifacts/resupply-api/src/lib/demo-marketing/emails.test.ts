import { describe, expect, it } from "vitest";

import {
  DEMO_DRIP_EMAILS,
  renderDemoFollowupOneEmail,
  renderDemoFollowupTwoEmail,
  renderDemoWelcomeEmail,
  type DemoEmailLinks,
} from "./emails";

const links: DemoEmailLinks = {
  demoUrl: "https://cmbreathe.com/admin?demo=1",
  featuresUrl: "https://cmbreathe.com/breathe-features",
  contactUrl: "mailto:info@cmbreathe.com",
  unsubscribeUrl: "https://cmbreathe.com/api/newsletter-unsubscribe?t=tok",
};

describe("demo drip emails", () => {
  it("welcome links to the demo and is platform-branded", () => {
    const e = renderDemoWelcomeEmail(links);
    expect(e.subject).toMatch(/demo/i);
    expect(e.html).toContain("CareMetric Breathe");
    expect(e.html).toContain(links.demoUrl);
    expect(e.text).toContain(links.demoUrl);
  });

  it("follow-up 1 points at the features page", () => {
    const e = renderDemoFollowupOneEmail(links);
    expect(e.html).toContain(links.featuresUrl);
    expect(e.text).toContain(links.featuresUrl);
  });

  it("follow-up 2 makes the conversion ask with the contact link", () => {
    const e = renderDemoFollowupTwoEmail(links);
    expect(e.html).toContain("mailto:info@cmbreathe.com");
    expect(e.subject).toMatch(/ready/i);
  });

  it("every email carries the unsubscribe link in html and text", () => {
    for (const render of DEMO_DRIP_EMAILS) {
      const e = render(links);
      expect(e.html).toContain(links.unsubscribeUrl);
      expect(e.text).toContain(links.unsubscribeUrl);
      // Both bodies present and non-trivial.
      expect(e.html.length).toBeGreaterThan(200);
      expect(e.text.length).toBeGreaterThan(50);
    }
  });

  it("exposes exactly three drip stages in order", () => {
    expect(DEMO_DRIP_EMAILS).toHaveLength(3);
    expect(DEMO_DRIP_EMAILS[0]).toBe(renderDemoWelcomeEmail);
    expect(DEMO_DRIP_EMAILS[2]).toBe(renderDemoFollowupTwoEmail);
  });
});

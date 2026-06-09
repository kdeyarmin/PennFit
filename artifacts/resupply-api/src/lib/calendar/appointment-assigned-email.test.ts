import { describe, expect, it } from "vitest";

import { __forTests } from "./appointment-assigned-email";

const baseInput = {
  toEmail: "csr@example.com",
  assigneeName: "Jordan",
  startsAt: "2026-06-15T13:00:00.000Z",
  endsAt: "2026-06-15T13:30:00.000Z",
  eventType: "fitting_in_person",
  location: "Suite 200",
  assignedByEmail: "boss@example.com",
  dashboardUrl: "https://app.example.com/admin/company-calendar",
};

describe("appointment-assigned-email renderers", () => {
  it("typeLabel humanizes known types and defaults the rest", () => {
    expect(__forTests.typeLabel("fitting_in_person")).toBe("In-person fitting");
    expect(__forTests.typeLabel("follow_up")).toBe("Follow-up");
    expect(__forTests.typeLabel("nonsense")).toBe("Appointment");
  });

  it("text body carries the essentials and links to the dashboard", () => {
    const text = __forTests.renderText(baseInput);
    expect(text).toContain("Jordan");
    expect(text).toContain("In-person fitting");
    expect(text).toContain("Suite 200");
    expect(text).toContain(baseInput.dashboardUrl);
  });

  it("is PHI-light — no patient identity in the body", () => {
    const text = __forTests.renderText(baseInput);
    const html = __forTests.renderHtml(baseInput);
    // The helper has no patient input at all, so "patient" must never appear.
    expect(text).not.toMatch(/patient/i);
    expect(html).not.toMatch(/patient/i);
  });

  it("greets generically when the assignee has no display name", () => {
    const text = __forTests.renderText({ ...baseInput, assigneeName: null });
    expect(text).toContain("Hi there,");
  });

  it("html escapes the dashboard URL into the link href", () => {
    const html = __forTests.renderHtml(baseInput);
    expect(html).toContain(
      'href="https://app.example.com/admin/company-calendar"',
    );
    expect(html).toContain("In-person fitting");
  });
});

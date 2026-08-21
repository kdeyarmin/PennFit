// @vitest-environment jsdom
//
// Behavioral coverage for the withheld-outcome exit (FitWithheld).
//
// The product decision under test: when the engine declines to name a
// mask because of the PHOTO (`low_confidence` / `outside_validated_range`),
// the flow ENDS there and refers the patient to the DME company BY NAME —
// no "retake photo" loop. A patient who fought the capture into a
// low-confidence frame has already told us the photo path isn't working;
// the DME's team owns the next step (and can send a fresh scan link from
// the console when they judge another try worthwhile).
//
// The referral identity must be the RESOLVED tenant (`useCompanyContact`),
// never a typed-out brand: the fitter is multi-tenant, and every tenant's
// patients must be referred to that tenant. The contact module is mocked
// to a fictional DME so the assertions prove the name flows from the
// resolver — a hardcoded brand could not produce it.

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const contact = {
  name: "Acme Home Medical",
  legalName: "Acme Home Medical LLC",
  phoneE164: "+15551234567",
  phoneDisplay: "(555) 123-4567",
  email: "support@acmehm.example",
  generalEmail: "info@acmehm.example",
  websiteUrl: null,
  hours: "Mon–Fri 9a–5p ET",
  assistantStorefrontName: "Acme Assistant",
  assistantAdminName: "Acme Copilot",
};

vi.mock("@/lib/contact", () => ({
  useCompanyContact: () => contact,
}));
// FitWithheld never renders mask imagery; stub the asset-importing module
// so this test doesn't depend on image transforms.
vi.mock("@/lib/mask-images", () => ({
  getMaskImage: () => "",
  formatMaskType: (t: string) => t,
}));

import { FitWithheld } from "./clinical-results";
import type { FitAssessment, FitOutcome } from "@/lib/fit-assess-api";

function assessment(outcome: FitOutcome): FitAssessment {
  return {
    outcome,
    primary: null,
    alternatives: [],
    excluded: [
      {
        maskSlug: "airfit-f30i",
        maskName: "AirFit F30i",
        tier: 1,
        code: "magnet_contraindicated",
        patientReason: "contains magnets, which your implant rules out",
      },
    ],
    recommendationConfidence: 0,
    safetyFlags: [],
    guidance: "A respiratory therapist will fit you personally.",
    disclaimer: "This tool does not replace clinical judgment.",
    provenance: {
      rulesEngineVersion: "test",
      formularyName: "Test Formulary",
      formularyVersion: 1,
      degraded: false,
    },
    fitSessionId: null,
  };
}

beforeEach(() => {
  cleanup();
  contact.phoneE164 = "+15551234567";
  contact.phoneDisplay = "(555) 123-4567";
});

describe("FitWithheld — scan-driven outcomes end with a named DME referral", () => {
  it("refers to the resolved DME by name, with no retake loop", () => {
    render(<FitWithheld assessment={assessment("low_confidence")} />);

    // Title stays cause-neutral: low confidence can come from the photo,
    // a weak match, or a sparse profile — the copy must be true for all
    // three, so it owns the refusal ("rather not guess"), not a cause.
    expect(screen.getByText("We'd rather not guess")).toBeTruthy();
    // The body names the resolved tenant, not a hardcoded brand.
    expect(screen.getByTestId("withheld-guidance").textContent).toContain(
      "Acme Home Medical",
    );
    expect(document.body.textContent).not.toContain("CareMetric");

    // The flow ENDS here: contact + call, never another camera round.
    // (`asChild` renders the Button AS the anchor, so the testid element
    // is the <a> itself.)
    const contactCta = screen.getByTestId("withheld-contact");
    expect(contactCta.textContent).toContain("Contact Acme Home Medical");
    expect(contactCta.tagName).toBe("A");
    expect(contactCta.getAttribute("href")).toBe("/contact");
    expect(screen.queryByTestId("withheld-retake")).toBeNull();
    expect(screen.queryByText(/retake photo/i)).toBeNull();
  });

  it("offers a tel: CTA from the tenant's own number", () => {
    render(<FitWithheld assessment={assessment("low_confidence")} />);
    const call = screen.getByTestId("withheld-call");
    expect(call.textContent).toContain("(555) 123-4567");
    expect(call.tagName).toBe("A");
    expect(call.getAttribute("href")).toBe("tel:+15551234567");
  });

  it("hides the call CTA when the tenant has no phone number", () => {
    contact.phoneE164 = "";
    contact.phoneDisplay = "";
    render(<FitWithheld assessment={assessment("low_confidence")} />);
    expect(screen.queryByTestId("withheld-call")).toBeNull();
    expect(screen.getByTestId("withheld-contact")).toBeTruthy();
  });

  it("hides the exclusion list for scan-driven stops", () => {
    // Under a scan-driven stop, "what we ruled out" reads as "every mask
    // rejected you" — but the photo was the problem, not the patient.
    render(<FitWithheld assessment={assessment("low_confidence")} />);
    expect(screen.queryByText("AirFit F30i")).toBeNull();
    expect(screen.queryByText("What we ruled out")).toBeNull();
  });

  it("ends outside_validated_range the same way, under its own title", () => {
    render(<FitWithheld assessment={assessment("outside_validated_range")} />);
    expect(
      screen.getByText("Your measurements sit outside our sizing range"),
    ).toBeTruthy();
    const body = screen.getByTestId("withheld-guidance").textContent ?? "";
    expect(body).toContain("Acme Home Medical");
    // This outcome can be a perfectly good scan of a face outside the
    // sizing data — the body must blame the RANGE, never the photo.
    expect(body).toContain("outside the range");
    expect(body).not.toMatch(/photo/i);
    expect(screen.queryByTestId("withheld-retake")).toBeNull();
  });
});

describe("FitWithheld — contraindicated keeps its clinical explanation", () => {
  it("shows the engine guidance and the ruled-out list, with the named CTA", () => {
    render(<FitWithheld assessment={assessment("contraindicated")} />);
    expect(
      screen.getByText("This one needs a person, not an algorithm"),
    ).toBeTruthy();
    // Contraindication is about the ANSWERS, so the engine's guidance and
    // the exclusions stay — the patient deserves the why.
    expect(screen.getByTestId("withheld-guidance").textContent).toContain(
      "A respiratory therapist will fit you personally.",
    );
    expect(screen.getByText("What we ruled out")).toBeTruthy();
    expect(screen.getByText("AirFit F30i")).toBeTruthy();
    expect(screen.getByTestId("withheld-contact").textContent).toContain(
      "Acme Home Medical",
    );
    expect(screen.queryByTestId("withheld-retake")).toBeNull();
  });
});

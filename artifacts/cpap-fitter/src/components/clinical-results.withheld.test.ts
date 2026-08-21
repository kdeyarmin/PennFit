// Pins the withheld-outcome exit in components/clinical-results.tsx.
//
// The product decision under test: when the engine declines to name a
// mask because of the PHOTO (`low_confidence` / `outside_validated_range`),
// the flow ENDS there and refers the patient to the DME company BY NAME —
// no "retake photo" loop. A patient who fought the capture into a
// low-confidence frame has already told us the photo path isn't working;
// the DME's team owns the next step (and can send a fresh scan link from
// the console when they judge another try worthwhile).
//
// Also pinned: the referral identity is RESOLVED (`useCompanyContact`),
// never a typed-out brand — the fitter is multi-tenant and every tenant's
// patients must be referred to that tenant, not to the seed tenant.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "clinical-results.tsx"), "utf8");

/** The FitWithheld component's slice of the source. */
const WITHHELD = SRC.slice(SRC.indexOf("export function FitWithheld"));

describe("FitWithheld — the flow ends with a named DME referral", () => {
  it("offers no retake loop", () => {
    expect(WITHHELD).not.toContain("withheld-retake");
    expect(WITHHELD).not.toContain("onRetake");
    expect(WITHHELD).not.toMatch(/Retake photo/);
  });

  it("refers to the resolved company identity, not a typed brand", () => {
    expect(SRC).toContain('import { useCompanyContact } from "@/lib/contact"');
    expect(WITHHELD).toContain("useCompanyContact()");
    expect(WITHHELD).toContain("Contact {contact.name}");
    // Multi-tenant: no hardcoded tenant brand may appear in the exit copy.
    expect(WITHHELD).not.toMatch(/PennPaps|Penn Home Medical/);
  });

  it("offers a phone CTA only when the tenant has a number", () => {
    expect(WITHHELD).toContain("contact.phoneE164 ? (");
    expect(WITHHELD).toContain("tel:${contact.phoneE164}");
  });

  it("hides the exclusion list for scan-driven stops", () => {
    // Under a scan-driven stop, "what we ruled out" reads as "every mask
    // rejected you" — but the photo was the problem, not the patient.
    expect(WITHHELD).toContain(
      "!scanLimited && assessment.excluded.length > 0",
    );
  });

  it("keeps distinct titles per outcome", () => {
    expect(WITHHELD).toContain("This one needs a person, not an algorithm");
    expect(WITHHELD).toContain(
      "Your measurements sit outside our sizing range",
    );
    expect(WITHHELD).toContain(
      "We couldn't size you confidently from that photo",
    );
  });
});

describe("results page — withheld outcomes end the flow", () => {
  const RESULTS_SRC = readFileSync(
    path.join(__dirname, "..", "pages", "results.tsx"),
    "utf8",
  );

  it("renders FitWithheld without a retake callback", () => {
    expect(RESULTS_SRC).toContain("<FitWithheld assessment={assessment} />");
  });
});

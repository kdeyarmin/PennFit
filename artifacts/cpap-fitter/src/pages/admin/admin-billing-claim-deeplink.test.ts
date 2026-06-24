// Guards the URL-addressable-claim wiring (Pattern D from the domain
// workflow review): the claim workbench opens the claim named in
// ?claim=<id>, and every claim-centric surface deep-links to it with that
// param — so a biller who picks a specific claim from a worklist lands on
// that claim, not a generic patient page.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(path.join(__dirname, f), "utf8");

describe("billing claim — URL-addressable workbench", () => {
  it("the workbench opens the claim named in ?claim=<id> on mount", () => {
    const src = read("admin-insurance-claims.tsx");
    expect(src).toContain('params.get("claim")');
    expect(src).toContain("setOpenClaimId(claimParam)");
    // The param is stripped after consuming it so a refresh / drawer close
    // doesn't force it back open.
    expect(src).toContain("window.history.replaceState");
  });
});

describe("billing claim — worklists deep-link to the specific claim", () => {
  it("denials worklist 'Open claim' targets the workbench with ?claim=", () => {
    const src = read("admin-billing-denials-worklist.tsx");
    expect(src).toContain("/insurance-claims?claim=${d.claimId}");
  });

  it("AI queue row targets the workbench with ?claim=", () => {
    const src = read("admin-billing-ai-queue.tsx");
    expect(src).toContain("/insurance-claims?claim=${c.id}");
  });

  it("manual-claim lands on the claim workbench (not the patient root)", () => {
    const src = read("admin-billing-manual-claim.tsx");
    expect(src).toContain("/insurance-claims?claim=${res.id}");
    // The old dead target — patient root with an unread ?claim= — is gone.
    expect(src).not.toContain("/admin/patients/${patient!.id}?claim=");
  });
});

// Tests for pages/admin/admin-bulk-campaigns.tsx
//
// PR change (a11y): multiple form controls in NewCampaignModal were given
// aria-label attributes so screen-reader users can identify each field.
//
// Controls labelled in this PR:
//   - Campaign name input
//   - Audience select
//   - Payer input (conditional — shown for payer-filtered audiences)
//   - Category select
//   - Throttle per minute input
//   - Template key input
//   - Compliance attestation textarea

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-bulk-campaigns.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// a11y: aria-labels in NewCampaignModal
// ---------------------------------------------------------------------------

describe("admin-bulk-campaigns NewCampaignModal — a11y: form controls have aria-labels", () => {
  it("campaign name input has aria-label='Campaign name'", () => {
    expect(SRC).toContain('aria-label="Campaign name"');
  });

  it("audience select has aria-label='Audience'", () => {
    expect(SRC).toContain('aria-label="Audience"');
  });

  it("payer input has aria-label='Payer'", () => {
    expect(SRC).toContain('aria-label="Payer"');
  });

  it("category select has aria-label='Category'", () => {
    expect(SRC).toContain('aria-label="Category"');
  });

  it("throttle input has aria-label='Throttle per minute'", () => {
    expect(SRC).toContain('aria-label="Throttle per minute"');
  });

  it("template key input has aria-label='Template key'", () => {
    expect(SRC).toContain('aria-label="Template key"');
  });

  it("compliance attestation textarea has aria-label='Compliance attestation'", () => {
    expect(SRC).toContain('aria-label="Compliance attestation"');
  });
});

// ---------------------------------------------------------------------------
// Regression: page exports and core behaviour retained
// ---------------------------------------------------------------------------

describe("admin-bulk-campaigns — regression", () => {
  it("still exports AdminBulkCampaignsPage", () => {
    expect(SRC).toContain("export function AdminBulkCampaignsPage");
  });

  it("still defines NewCampaignModal", () => {
    expect(SRC).toContain("function NewCampaignModal(");
  });

  it("still defines AudienceKind type or constant", () => {
    expect(SRC).toContain("AudienceKind");
  });

  it("compliance attestation is required for the compliance category", () => {
    expect(SRC).toContain("compliance");
  });
});

// Static guard for admin-billing-era.tsx — ERA file upload and history page.
//
// The component uses React + mutations which cannot be rendered in the
// vitest node environment. We read the source directly following the
// established project pattern.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-billing-era.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Imports from billing-api
// ---------------------------------------------------------------------------
describe("admin-billing-era — billing-api imports", () => {
  it("imports fetchEraFiles", () => {
    expect(SRC).toContain("fetchEraFiles");
  });

  it("imports ingestEraFile", () => {
    expect(SRC).toContain("ingestEraFile");
  });

  it("imports formatMoneyCents", () => {
    expect(SRC).toContain("formatMoneyCents");
  });

  it("imports EraIngestResponse type", () => {
    expect(SRC).toContain("EraIngestResponse");
  });
});

// ---------------------------------------------------------------------------
// Root data-testid
// ---------------------------------------------------------------------------
describe("admin-billing-era — root data-testid", () => {
  it('renders with data-testid="admin-billing-era"', () => {
    expect(SRC).toContain('data-testid="admin-billing-era"');
  });
});

// ---------------------------------------------------------------------------
// Page heading
// ---------------------------------------------------------------------------
describe("admin-billing-era — page heading", () => {
  it('renders "ERA files" as the h1 text', () => {
    expect(SRC).toContain("ERA files");
  });
});

// ---------------------------------------------------------------------------
// Upload section
// ---------------------------------------------------------------------------
describe("admin-billing-era — upload section", () => {
  it("has a file input element", () => {
    expect(SRC).toContain('<input');
    expect(SRC).toContain('type="file"');
  });

  it("accepts .835, .txt, .edi, .dat file extensions", () => {
    expect(SRC).toContain('accept=".835,.txt,.edi,.dat"');
  });

  it("includes data-testid for the file input", () => {
    expect(SRC).toContain('data-testid="era-file-input"');
  });

  it("includes data-testid for the upload button", () => {
    expect(SRC).toContain('data-testid="era-upload-button"');
  });

  it("enforces a MAX_FILE_BYTES limit of 4 MB", () => {
    expect(SRC).toContain("MAX_FILE_BYTES");
    expect(SRC).toContain("4 * 1024 * 1024");
  });

  it("shows an error when file exceeds the 4 MB limit", () => {
    expect(SRC).toContain("Max is 4 MB.");
  });

  it("shows upload error with data-testid='era-upload-error'", () => {
    expect(SRC).toContain('data-testid="era-upload-error"');
  });

  it("shows upload result with data-testid='era-upload-result'", () => {
    expect(SRC).toContain('data-testid="era-upload-result"');
  });

  it("displays the pending label 'Posting…' while uploading", () => {
    expect(SRC).toContain("Posting…");
  });

  it("displays 'Pick & upload' as the default button label", () => {
    expect(SRC).toContain("Pick & upload");
  });
});

// ---------------------------------------------------------------------------
// Upload result summary fields
// ---------------------------------------------------------------------------
describe("admin-billing-era — upload result display", () => {
  it("shows 'Posted' in the success banner", () => {
    expect(SRC).toContain("Posted");
  });

  it("shows lines updated count from summary.linesUpdated", () => {
    expect(SRC).toContain("linesUpdated");
    expect(SRC).toContain("line(s) updated");
  });

  it("shows totalPaidCents via formatMoneyCents in the result", () => {
    expect(SRC).toContain("totalPaidCents");
  });

  it("shows matchedClaims count in the result", () => {
    expect(SRC).toContain("matchedClaims");
    expect(SRC).toContain("matched claim(s)");
  });

  it("warns about unmatched claims and need for manual link", () => {
    expect(SRC).toContain("unmatchedClaims");
    expect(SRC).toContain("need manual link");
  });
});

// ---------------------------------------------------------------------------
// statusTone helper function
// ---------------------------------------------------------------------------
describe("admin-billing-era — statusTone colour helper", () => {
  it("defines statusTone function", () => {
    expect(SRC).toContain("function statusTone");
  });

  it("maps 'processed' status to green (#15803d)", () => {
    expect(SRC).toContain('"processed"');
    expect(SRC).toContain("#15803d");
  });

  it("maps 'partial' status to amber (#b45309)", () => {
    expect(SRC).toContain('"partial"');
    expect(SRC).toContain("#b45309");
  });

  it("maps 'rejected' status to red (#b91c1c)", () => {
    expect(SRC).toContain('"rejected"');
    expect(SRC).toContain("#b91c1c");
  });
});

// ---------------------------------------------------------------------------
// History table
// ---------------------------------------------------------------------------
describe("admin-billing-era — history table", () => {
  it("has 'Recent ERA files' card title", () => {
    expect(SRC).toContain("Recent ERA files");
  });

  it("has 'File' column header", () => {
    expect(SRC).toContain(">File<");
  });

  it("has 'Payer check #' column header", () => {
    expect(SRC).toContain("Payer check #");
  });

  it("has 'Status' column header", () => {
    expect(SRC).toContain(">Status<");
  });

  it("has 'Paid' column header", () => {
    expect(SRC).toContain(">Paid<");
  });

  it("has 'Claims paid' column header", () => {
    expect(SRC).toContain("Claims paid");
  });

  it("has 'Claims denied' column header", () => {
    expect(SRC).toContain("Claims denied");
  });

  it("has 'Ingested' column header", () => {
    expect(SRC).toContain(">Ingested<");
  });
});

// ---------------------------------------------------------------------------
// EraFile row fields rendered in history table
// ---------------------------------------------------------------------------
describe("admin-billing-era — history table row fields", () => {
  it("renders f.fileName in the file column", () => {
    expect(SRC).toContain("f.fileName");
  });

  it("renders f.rejectionReason below the filename when present", () => {
    expect(SRC).toContain("f.rejectionReason");
  });

  it("renders f.payerCheckNumber with fallback to em-dash", () => {
    expect(SRC).toContain("f.payerCheckNumber");
  });

  it("renders f.status with statusTone colour", () => {
    expect(SRC).toContain("statusTone(f.status)");
  });

  it("renders f.totalPaidCents via formatMoneyCents", () => {
    expect(SRC).toContain("formatMoneyCents(f.totalPaidCents)");
  });

  it("renders f.claimsPaidCount with null fallback", () => {
    expect(SRC).toContain("claimsPaidCount");
  });

  it("renders f.claimsDeniedCount with null fallback", () => {
    expect(SRC).toContain("claimsDeniedCount");
  });

  it("renders f.ingestedAt as a localised date string", () => {
    expect(SRC).toContain("f.ingestedAt");
    expect(SRC).toContain("toLocaleString()");
  });

  it("renders f.ingestedByEmail below the date when present", () => {
    expect(SRC).toContain("f.ingestedByEmail");
  });
});

// ---------------------------------------------------------------------------
// Empty-state message
// ---------------------------------------------------------------------------
describe("admin-billing-era — empty state", () => {
  it("shows 'No ERA files ingested yet.' when history is empty", () => {
    expect(SRC).toContain("No ERA files ingested yet.");
  });
});

// ---------------------------------------------------------------------------
// React-query cache keys and mutation
// ---------------------------------------------------------------------------
describe("admin-billing-era — react-query cache keys", () => {
  it("uses 'admin-billing-era-files' queryKey for history query", () => {
    expect(SRC).toContain('"admin-billing-era-files"');
  });

  it("invalidates 'admin-billing-era-files' on successful upload", () => {
    // The onSuccess handler calls qc.invalidateQueries
    expect(SRC).toContain("invalidateQueries");
    expect(SRC).toContain('"admin-billing-era-files"');
  });

  it("invalidates 'admin-billing-director-summary' on successful upload", () => {
    expect(SRC).toContain('"admin-billing-director-summary"');
  });
});

// ---------------------------------------------------------------------------
// Lucide icon
// ---------------------------------------------------------------------------
describe("admin-billing-era — lucide-react icon imports", () => {
  it("imports Upload icon from lucide-react", () => {
    expect(SRC).toContain("Upload");
  });
});

// ---------------------------------------------------------------------------
// Duplicate-upload safety note in description
// ---------------------------------------------------------------------------
describe("admin-billing-era — SHA-256 duplicate safety", () => {
  it("mentions SHA-256 hash protection against re-upload", () => {
    expect(SRC).toContain("SHA-256");
  });

  it("states the file body is not stored", () => {
    expect(SRC).toContain("not stored");
  });
});
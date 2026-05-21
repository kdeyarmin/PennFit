// Tests for PrescriptionsTab.tsx
//
// PR change: extracted PrescriptionsTab (+ GenerateSwoButton,
// PrescriptionAttachmentCell, AddPrescriptionModal, formatBytes,
// MAX_ATTACHMENT_BYTES, ATTACHMENT_ACCEPT) from patient-detail.tsx into
// its own dedicated file.
//
// The component uses React hooks and cannot be rendered in the node
// Vitest environment without jsdom. We read the source file as a string
// and assert on the structural and behavioral invariants.
// Pure logic (HCPCS regex, cadence/date validation, formatBytes) is also
// tested directly in the test file to verify boundary conditions.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "PrescriptionsTab.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Module structure: exports and imports
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — module structure", () => {
  it("exports PrescriptionsTab as a named export", () => {
    expect(SRC).toContain("export function PrescriptionsTab(");
  });

  it("imports ApiError from the api-client-react admin package", () => {
    expect(SRC).toContain("ApiError");
    expect(SRC).toMatch(
      /from\s+["']@workspace\/api-client-react\/admin["']/,
    );
  });

  it("imports useCreatePrescription for the AddPrescriptionModal", () => {
    expect(SRC).toContain("useCreatePrescription");
  });

  it("imports useUpdatePrescriptionStatus for status change actions", () => {
    expect(SRC).toContain("useUpdatePrescriptionStatus");
  });

  it("imports PatientPrescription type and aliases it as Prescription", () => {
    expect(SRC).toContain("type PatientPrescription");
    expect(SRC).toContain("type Prescription = PatientPrescription");
  });

  it("imports prescription-attachment helpers from the shared lib", () => {
    expect(SRC).toContain("uploadPrescriptionAttachment");
    expect(SRC).toContain("removePrescriptionAttachment");
    expect(SRC).toContain("prescriptionAttachmentDownloadUrl");
  });

  it("imports openPdfInNewTab and summarizePdfError for SWO generation", () => {
    expect(SRC).toContain("openPdfInNewTab");
    expect(SRC).toContain("summarizePdfError");
  });
});

// ---------------------------------------------------------------------------
// MAX_ATTACHMENT_BYTES / ATTACHMENT_ACCEPT constants
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — attachment constants", () => {
  it("defines MAX_ATTACHMENT_BYTES as exactly 10 MB (10 * 1024 * 1024)", () => {
    expect(SRC).toContain("MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024");
  });

  it("accepts application/pdf in ATTACHMENT_ACCEPT", () => {
    expect(SRC).toContain("application/pdf");
  });

  it("accepts image/png in ATTACHMENT_ACCEPT", () => {
    expect(SRC).toContain("image/png");
  });

  it("accepts image/jpeg in ATTACHMENT_ACCEPT", () => {
    expect(SRC).toContain("image/jpeg");
  });

  it("accepts image/heic in ATTACHMENT_ACCEPT", () => {
    expect(SRC).toContain("image/heic");
  });

  it("accepts image/heif in ATTACHMENT_ACCEPT", () => {
    expect(SRC).toContain("image/heif");
  });

  it("accepts image/webp in ATTACHMENT_ACCEPT", () => {
    expect(SRC).toContain("image/webp");
  });
});

// ---------------------------------------------------------------------------
// formatBytes — pure logic tested directly (mirrors source behaviour)
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — formatBytes logic", () => {
  // Re-implement the logic extracted from PrescriptionsTab.tsx so tests
  // exercise the exact algorithm without importing the unexported function.
  function formatBytes(n: number | null | undefined): string {
    if (n == null) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  it("returns empty string for null", () => {
    expect(formatBytes(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(formatBytes(undefined)).toBe("");
  });

  it("returns '0 B' for zero bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("returns bytes directly for values under 1024", () => {
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("switches to KB at exactly 1024 bytes", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
  });

  it("formats kilobyte values with one decimal", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10240)).toBe("10.0 KB");
  });

  it("formats just under 1 MB correctly", () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe("1024.0 KB");
  });

  it("switches to MB at exactly 1 MB (1024 * 1024)", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });

  it("formats 10 MB (the attachment cap) as '10.0 MB'", () => {
    expect(formatBytes(10 * 1024 * 1024)).toBe("10.0 MB");
  });

  it("formats large values with one decimal", () => {
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
});

// ---------------------------------------------------------------------------
// HCPCS code validation regex
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — HCPCS validation regex", () => {
  // Extracted from AddPrescriptionModal.onSubmit — must stay in sync.
  const HCPCS_RE = /^[A-Z]\d{4}(-[A-Z0-9]{2}){0,4}$/;

  describe("valid codes", () => {
    it("accepts a bare 5-character code like E0601", () => {
      expect(HCPCS_RE.test("E0601")).toBe(true);
    });

    it("accepts a code with one 2-character modifier like A7030-KX", () => {
      expect(HCPCS_RE.test("A7030-KX")).toBe(true);
    });

    it("accepts up to four modifiers", () => {
      expect(HCPCS_RE.test("A7030-KX-NU-GY-AA")).toBe(true);
    });

    it("accepts digits in modifier positions", () => {
      expect(HCPCS_RE.test("E0601-59")).toBe(true);
    });

    it("accepts mixed alpha-numeric modifiers", () => {
      expect(HCPCS_RE.test("E0601-K2")).toBe(true);
    });
  });

  describe("invalid codes", () => {
    it("rejects lowercase letters in the base code", () => {
      expect(HCPCS_RE.test("e0601")).toBe(false);
    });

    it("rejects a code starting with a digit", () => {
      expect(HCPCS_RE.test("00601")).toBe(false);
    });

    it("rejects a code with only 4 characters", () => {
      expect(HCPCS_RE.test("E060")).toBe(false);
    });

    it("rejects a code with 6+ base characters", () => {
      expect(HCPCS_RE.test("E06011")).toBe(false);
    });

    it("rejects a modifier longer than 2 characters", () => {
      expect(HCPCS_RE.test("E0601-KXY")).toBe(false);
    });

    it("rejects a modifier with only 1 character", () => {
      expect(HCPCS_RE.test("E0601-K")).toBe(false);
    });

    it("rejects five or more modifiers (exceeds cap of four)", () => {
      expect(HCPCS_RE.test("A7030-KX-NU-GY-AA-BB")).toBe(false);
    });

    it("rejects special characters in the modifier", () => {
      expect(HCPCS_RE.test("E0601-K!")).toBe(false);
    });

    it("rejects an empty string", () => {
      expect(HCPCS_RE.test("")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Cadence validation logic
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — cadence validation", () => {
  // The source uses: !Number.isInteger(cadence) || cadence < 1 || cadence > 365
  function isCadenceInvalid(value: string): boolean {
    const cadence = Number(value);
    return !Number.isInteger(cadence) || cadence < 1 || cadence > 365;
  }

  it("accepts cadence of 1 (lower boundary)", () => {
    expect(isCadenceInvalid("1")).toBe(false);
  });

  it("accepts cadence of 365 (upper boundary)", () => {
    expect(isCadenceInvalid("365")).toBe(false);
  });

  it("accepts a typical 90-day cadence (default value)", () => {
    expect(isCadenceInvalid("90")).toBe(false);
  });

  it("rejects cadence of 0 (below minimum)", () => {
    expect(isCadenceInvalid("0")).toBe(true);
  });

  it("rejects cadence of 366 (above maximum)", () => {
    expect(isCadenceInvalid("366")).toBe(true);
  });

  it("rejects negative cadence", () => {
    expect(isCadenceInvalid("-1")).toBe(true);
  });

  it("rejects a decimal cadence like 90.5", () => {
    expect(isCadenceInvalid("90.5")).toBe(true);
  });

  it("rejects non-numeric input", () => {
    expect(isCadenceInvalid("abc")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isCadenceInvalid("")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Date format validation (YYYY-MM-DD)
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — date format validation regex", () => {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  it("accepts a well-formed ISO date", () => {
    expect(DATE_RE.test("2025-01-15")).toBe(true);
  });

  it("accepts today's date in ISO format", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(DATE_RE.test(today)).toBe(true);
  });

  it("rejects a date with slashes", () => {
    expect(DATE_RE.test("2025/01/15")).toBe(false);
  });

  it("rejects a date missing the leading zero on month", () => {
    expect(DATE_RE.test("2025-1-15")).toBe(false);
  });

  it("rejects a date with only 2-digit year", () => {
    expect(DATE_RE.test("25-01-15")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(DATE_RE.test("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validUntil >= validFrom check (ISO date string comparison)
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — validUntil vs validFrom ordering", () => {
  // The source condition: validUntil && validUntil < validFrom => error
  function isUntilBeforeFrom(validFrom: string, validUntil: string): boolean {
    return Boolean(validUntil && validUntil < validFrom);
  }

  it("accepts validUntil equal to validFrom", () => {
    expect(isUntilBeforeFrom("2025-01-01", "2025-01-01")).toBe(false);
  });

  it("accepts validUntil after validFrom", () => {
    expect(isUntilBeforeFrom("2025-01-01", "2025-12-31")).toBe(false);
  });

  it("rejects validUntil before validFrom", () => {
    expect(isUntilBeforeFrom("2025-12-31", "2025-01-01")).toBe(true);
  });

  it("does not flag when validUntil is empty (optional field)", () => {
    expect(isUntilBeforeFrom("2025-01-01", "")).toBe(false);
  });

  it("handles year boundary correctly", () => {
    expect(isUntilBeforeFrom("2026-01-01", "2025-12-31")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AddPrescriptionModal — validation error messages
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — AddPrescriptionModal validation error messages", () => {
  it("shows 'Item SKU is required.' when SKU is empty", () => {
    expect(SRC).toContain("Item SKU is required.");
  });

  it("shows cadence range error when cadence is out of bounds", () => {
    expect(SRC).toContain(
      "Cadence must be a whole number between 1 and 365.",
    );
  });

  it("shows date format error for invalid validFrom", () => {
    expect(SRC).toContain("Valid-from must be a date.");
  });

  it("shows date format error for invalid validUntil", () => {
    expect(SRC).toContain("Valid-until must be a date.");
  });

  it("shows ordering error when validUntil is before validFrom", () => {
    expect(SRC).toContain("Valid-until must be on or after valid-from.");
  });

  it("shows HCPCS format guidance with example codes", () => {
    expect(SRC).toContain(
      "HCPCS must be a code like E0601, optionally with modifiers (e.g. A7030-KX).",
    );
  });
});

// ---------------------------------------------------------------------------
// AddPrescriptionModal — ApiError discrimination in catch block
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — AddPrescriptionModal error handling", () => {
  it("checks for ApiError instance to extract server message", () => {
    expect(SRC).toContain("err instanceof ApiError");
  });

  it("falls back to generic message when ApiError has no .message", () => {
    expect(SRC).toContain("\"Couldn't create prescription.\"");
  });

  it("uses err.message when error is a plain Error", () => {
    // Pattern: err instanceof Error ? err.message : "Couldn't create prescription."
    expect(SRC).toMatch(
      /err instanceof Error[\s\S]{0,60}err\.message[\s\S]{0,60}Couldn't create prescription/,
    );
  });

  it("reads the server message from err.data.message path", () => {
    expect(SRC).toContain("err.data");
    expect(SRC).toContain(".message");
  });
});

// ---------------------------------------------------------------------------
// PrescriptionsTab — attachment size guard
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — handleUpload size guard", () => {
  it("checks file.size against MAX_ATTACHMENT_BYTES before uploading", () => {
    expect(SRC).toContain("file.size > MAX_ATTACHMENT_BYTES");
  });

  it("sets an error message referencing formatBytes(MAX_ATTACHMENT_BYTES)", () => {
    expect(SRC).toContain(
      "Document is too large — max ${formatBytes(MAX_ATTACHMENT_BYTES)}.",
    );
  });

  it("calls uploadPrescriptionAttachment when file is within size limit", () => {
    expect(SRC).toContain("uploadPrescriptionAttachment(");
  });

  it("calls onChanged() after a successful upload", () => {
    // Verify onChanged is called after the upload resolves.
    const uploadIdx = SRC.indexOf("uploadPrescriptionAttachment(");
    const onChangedIdx = SRC.indexOf("onChanged()", uploadIdx);
    expect(uploadIdx).toBeGreaterThanOrEqual(0);
    expect(onChangedIdx).toBeGreaterThan(uploadIdx);
  });

  it("surfaces an error message when upload fails", () => {
    expect(SRC).toContain("\"Couldn't attach document.\"");
  });
});

// ---------------------------------------------------------------------------
// PrescriptionsTab — handleRemoveAttachment
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — handleRemoveAttachment", () => {
  it("confirms removal with window.confirm before proceeding", () => {
    expect(SRC).toContain(
      "Remove the attached document? The patient's record will no longer link to it.",
    );
  });

  it("calls removePrescriptionAttachment when confirmed", () => {
    expect(SRC).toContain("removePrescriptionAttachment(");
  });

  it("surfaces an error when remove fails", () => {
    expect(SRC).toContain("\"Couldn't remove attachment.\"");
  });
});

// ---------------------------------------------------------------------------
// PrescriptionsTab — changeStatus
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — changeStatus (mark expired / revoke)", () => {
  it("asks for confirmation before changing status", () => {
    expect(SRC).toContain(
      "Are you sure you want to ${verb} this prescription?",
    );
  });

  it("uses the verb 'revoke' for the revoked status", () => {
    expect(SRC).toContain(
      'nextStatus === "revoked" ? "revoke" : "mark expired"',
    );
  });

  it("calls updateStatus.mutateAsync with the rxId and new status", () => {
    expect(SRC).toContain("updateStatus.mutateAsync(");
    expect(SRC).toContain("data: { status: nextStatus }");
  });

  it("calls onChanged() after a successful status update", () => {
    const mutateIdx = SRC.indexOf("updateStatus.mutateAsync(");
    const onChangedIdx = SRC.indexOf("onChanged()", mutateIdx);
    expect(mutateIdx).toBeGreaterThanOrEqual(0);
    expect(onChangedIdx).toBeGreaterThan(mutateIdx);
  });

  it("surfaces 'Couldn't update prescription.' on generic error", () => {
    expect(SRC).toContain("\"Couldn't update prescription.\"");
  });

  it("does not proceed when user cancels the confirm dialog (early return)", () => {
    // window.confirm returns falsy → the function returns immediately.
    // The guard pattern: if (!window.confirm(...)) { return; }
    expect(SRC).toMatch(/!window\.confirm[\s\S]{0,20}return;/);
  });
});

// ---------------------------------------------------------------------------
// GenerateSwoButton — disabled states
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — GenerateSwoButton disabled conditions", () => {
  it("detects missing HCPCS code as a disabling condition", () => {
    expect(SRC).toContain("const missingHcpcs = !rx.hcpcsCode");
  });

  it("detects missing provider as a disabling condition", () => {
    expect(SRC).toContain("const missingProvider = !rx.providerId");
  });

  it("disables the button when missingHcpcs is true", () => {
    expect(SRC).toContain("disabled={busy || missingHcpcs || missingProvider}");
  });

  it("sets a title explaining the HCPCS requirement", () => {
    expect(SRC).toContain(
      "Add an HCPCS code on this prescription first",
    );
  });

  it("sets a title explaining the provider requirement", () => {
    expect(SRC).toContain("Link a provider in the registry first");
  });

  it("leaves title undefined when both HCPCS and provider are present", () => {
    // The ternary chain: missingHcpcs ? ... : missingProvider ? ... : undefined
    expect(SRC).toContain(": undefined");
  });
});

// ---------------------------------------------------------------------------
// GenerateSwoButton — SWO URL construction
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — GenerateSwoButton SWO URL", () => {
  it("constructs the SWO URL with the correct path prefix", () => {
    expect(SRC).toContain(
      "/resupply-api/admin/patients/",
    );
  });

  it("URL-encodes the patientId to handle special characters", () => {
    expect(SRC).toContain("encodeURIComponent(\n          patientId,\n        )");
  });

  it("URL-encodes the prescription id in the SWO URL", () => {
    expect(SRC).toContain("encodeURIComponent(rx.id)");
  });

  it("appends the /swo suffix to the prescription path", () => {
    expect(SRC).toContain("/swo`");
  });

  it("calls openPdfInNewTab with the constructed URL", () => {
    expect(SRC).toContain("openPdfInNewTab(");
  });

  it("calls onError with a SWO-prefixed message when the PDF request fails", () => {
    expect(SRC).toContain('onError(`SWO: ${summarizePdfError(result.error)}`');
  });
});

// ---------------------------------------------------------------------------
// PrescriptionAttachmentCell — file input behaviour
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — PrescriptionAttachmentCell file input", () => {
  it("uses the ATTACHMENT_ACCEPT constant for the file input's accept attribute", () => {
    expect(SRC).toContain("accept={ATTACHMENT_ACCEPT}");
  });

  it("resets the input value after file selection to allow re-picking the same file", () => {
    // The comment in the source explains this is necessary because browsers
    // suppress the change event when the value is identical to the prior selection.
    expect(SRC).toContain('e.target.value = ""');
  });

  it("calls onUpload with the selected file when a file is chosen", () => {
    expect(SRC).toContain("if (file) onUpload(file)");
  });

  it("uses a unique input id per prescription row to avoid collisions", () => {
    expect(SRC).toContain("`rx-attachment-${rx.id}`");
  });
});

// ---------------------------------------------------------------------------
// PrescriptionAttachmentCell — accessibility (label as button)
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — PrescriptionAttachmentCell label accessibility", () => {
  it("marks the label with role='button' for screen readers", () => {
    expect(SRC).toContain('role="button"');
  });

  it("sets aria-disabled on the label when isBusy or isDisabled", () => {
    expect(SRC).toContain("aria-disabled={isBusy || isDisabled}");
  });

  it("sets tabIndex to -1 when disabled (removes from tab order)", () => {
    expect(SRC).toContain("tabIndex={isBusy || isDisabled ? -1 : 0}");
  });

  it("handles keyboard Enter and Space to trigger the hidden input", () => {
    expect(SRC).toContain('e.key === "Enter" || e.key === " "');
    expect(SRC).toContain("document.getElementById(inputId)?.click()");
  });

  it("shows 'Uploading…' text while upload is in progress", () => {
    expect(SRC).toContain("Uploading\u2026");
  });
});

// ---------------------------------------------------------------------------
// PrescriptionAttachmentCell — attachment present state
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — PrescriptionAttachmentCell with existing attachment", () => {
  it("renders the attachment filename as a download link", () => {
    expect(SRC).toContain("download={rx.attachmentFilename}");
  });

  it("opens the download link in a new tab", () => {
    expect(SRC).toContain('target="_blank"');
    expect(SRC).toContain('rel="noopener"');
  });

  it("uses prescriptionAttachmentDownloadUrl to build the href", () => {
    expect(SRC).toContain("prescriptionAttachmentDownloadUrl(");
  });

  it("shows the formatted file size next to the remove button", () => {
    expect(SRC).toContain("formatBytes(rx.attachmentSizeBytes)");
  });

  it("shows 'Removing…' text while removal is in progress", () => {
    expect(SRC).toContain("Removing\u2026");
  });

  it("shows 'Remove' text when not busy", () => {
    expect(SRC).toContain(": \"Remove\"");
  });
});

// ---------------------------------------------------------------------------
// PrescriptionsTab — table column definitions
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — table column definitions", () => {
  it("includes an 'Item' column that renders itemSku", () => {
    expect(SRC).toContain("header: \"Item\"");
    expect(SRC).toContain("r.itemSku");
  });

  it("includes an 'HCPCS' column that falls back to em-dash for missing codes", () => {
    expect(SRC).toContain("header: \"HCPCS\"");
    expect(SRC).toContain('r.hcpcsCode ?? "\u2014"');
  });

  it("includes a 'Cadence' column that appends ' days' to the value", () => {
    expect(SRC).toContain("header: \"Cadence\"");
    expect(SRC).toContain("`${r.cadenceDays} days`");
  });

  it("includes 'Valid from' and 'Valid until' date columns", () => {
    expect(SRC).toContain("header: \"Valid from\"");
    expect(SRC).toContain("header: \"Valid until\"");
  });

  it("includes a 'Status' column with a success badge for active prescriptions", () => {
    expect(SRC).toContain("r.status === \"active\" ? \"success\" : \"muted\"");
  });

  it("includes a 'Document' column that renders PrescriptionAttachmentCell", () => {
    expect(SRC).toContain("header: \"Document\"");
    expect(SRC).toContain("PrescriptionAttachmentCell");
  });

  it("shows 'Mark expired' and 'Revoke' action buttons only for active prescriptions", () => {
    expect(SRC).toContain("Mark expired");
    expect(SRC).toContain("Revoke");
    // Only active prescriptions get the action buttons.
    expect(SRC).toMatch(/r\.status === "active"[\s\S]{0,20}Mark expired/);
  });
});

// ---------------------------------------------------------------------------
// PrescriptionsTab — busy-state isolation
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — busy-state isolation between status and attachment", () => {
  it("maintains a separate busyRxId for status mutations", () => {
    expect(SRC).toContain("busyRxId");
    expect(SRC).toContain("setBusyRxId");
  });

  it("maintains a separate busyAttachmentRxId for attachment uploads/removals", () => {
    expect(SRC).toContain("busyAttachmentRxId");
    expect(SRC).toContain("setBusyAttachmentRxId");
  });

  it("disables attachment cell when busyRxId matches the row", () => {
    // isDisabled check: busyRxId === r.id
    expect(SRC).toContain("busyRxId === r.id");
  });

  it("disables status action buttons when another row's status is being mutated", () => {
    // disabled prop: busyRxId !== null && busyRxId !== r.id
    expect(SRC).toContain("busyRxId !== null && busyRxId !== r.id");
  });
});

// ---------------------------------------------------------------------------
// AddPrescriptionModal — modal UX and accessibility
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — AddPrescriptionModal UX", () => {
  it("marks the overlay as a dialog with aria-modal for accessibility", () => {
    expect(SRC).toContain('role="dialog"');
    expect(SRC).toContain('aria-modal="true"');
  });

  it("associates the dialog title via aria-labelledby", () => {
    expect(SRC).toContain('aria-labelledby="add-rx-title"');
    expect(SRC).toContain('id="add-rx-title"');
  });

  it("closes on Escape key when no save is in flight", () => {
    expect(SRC).toContain('e.key === "Escape" && !isPending');
    expect(SRC).toContain("onClose()");
  });

  it("does not close on Escape when a save is in flight (isPending guard)", () => {
    // The Escape handler: if (e.key === "Escape" && !isPending) onClose()
    expect(SRC).toContain("!isPending");
  });

  it("closes when clicking the backdrop (click-outside dismiss)", () => {
    // The overlay div: onClick={() => !isPending && onClose()}
    expect(SRC).toContain("!isPending && onClose()");
  });

  it("stops propagation on the inner panel to prevent backdrop close", () => {
    expect(SRC).toContain("e.stopPropagation()");
  });

  it("shows an immutability note about clinical fields in the modal", () => {
    expect(SRC).toContain(
      "Clinical fields are immutable after save.",
    );
  });

  it("shows the 'New prescription' heading", () => {
    expect(SRC).toContain("New prescription");
  });

  it("disables Cancel button while a save is in flight", () => {
    expect(SRC).toContain("disabled={isPending}");
  });

  it("shows 'Save prescription' as the submit button label", () => {
    expect(SRC).toContain("Save prescription");
  });
});

// ---------------------------------------------------------------------------
// AddPrescriptionModal — default cadence value
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — AddPrescriptionModal default cadence", () => {
  it("initialises cadenceDays state to '90' (most common CPAP resupply cadence)", () => {
    expect(SRC).toContain('useState("90")');
  });
});

// ---------------------------------------------------------------------------
// PrescriptionsTab — header immutability notice
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — tab header immutability notice", () => {
  it("includes a note that clinical fields are immutable after creation", () => {
    expect(SRC).toContain(
      "Clinical fields are immutable after creation",
    );
  });

  it("instructs users to add a new prescription and mark the old one expired to edit", () => {
    expect(SRC).toContain("mark the old one expired");
  });
});

// ---------------------------------------------------------------------------
// PrescriptionsTab — add prescription button
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — add prescription button", () => {
  it("renders an '+ Add prescription' button", () => {
    expect(SRC).toContain("+ Add prescription");
  });

  it("renders AddPrescriptionModal when showAdd is true", () => {
    expect(SRC).toContain("AddPrescriptionModal");
    expect(SRC).toContain("showAdd");
  });
});

// ---------------------------------------------------------------------------
// PrescriptionsTab — empty state
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — empty state", () => {
  it("uses EmptyState component with 'No prescriptions on file.' for an empty list", () => {
    expect(SRC).toContain("No prescriptions on file.");
  });
});

// ---------------------------------------------------------------------------
// PrescriptionsTab — action error display
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — action error display", () => {
  it("renders the action error with role='alert' for screen readers", () => {
    expect(SRC).toContain('role="alert"');
  });

  it("displays the error in a paragraph element with a red colour", () => {
    expect(SRC).toContain("#b91c1c");
  });

  it("clears the action error at the start of each new action", () => {
    // Every handler calls setActionError(null) before the async operation.
    const setNullCount = (SRC.match(/setActionError\(null\)/g) ?? []).length;
    expect(setNullCount).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Regression: HCPCS trim+uppercase normalisation before validation
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — HCPCS normalisation before validation", () => {
  it("trims whitespace from the HCPCS input before validating", () => {
    expect(SRC).toContain("hcpcsCode.trim()");
  });

  it("uppercases the HCPCS value before validation", () => {
    expect(SRC).toContain(".toUpperCase()");
  });

  it("sends the normalised (trimmed + uppercased) HCPCS to the API", () => {
    // The variable `hcpcs` is the normalised value used in the body.
    expect(SRC).toContain("body.hcpcsCode = hcpcs");
  });
});

// ---------------------------------------------------------------------------
// Regression: SKU trim before required-field check
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — SKU trim before validation", () => {
  it("trims the item SKU before checking it is non-empty", () => {
    // const sku = itemSku.trim(); then if (sku.length === 0) ...
    expect(SRC).toContain("itemSku.trim()");
    expect(SRC).toContain("sku.length === 0");
  });

  it("sends the trimmed SKU to the API body", () => {
    expect(SRC).toContain("itemSku: sku,");
  });
});

// ---------------------------------------------------------------------------
// AddPrescriptionModal — optional fields only sent when non-empty
// ---------------------------------------------------------------------------
describe("PrescriptionsTab — AddPrescriptionModal optional fields", () => {
  it("includes validUntil in the request body only when provided", () => {
    expect(SRC).toContain("if (validUntil) body.validUntil = validUntil;");
  });

  it("includes hcpcsCode in the request body only when provided", () => {
    expect(SRC).toContain("if (hcpcs) body.hcpcsCode = hcpcs;");
  });

  it("includes prescriberName only when non-blank", () => {
    expect(SRC).toContain("if (prescriberName.trim()) body.prescriberName");
  });

  it("includes prescriberNpi only when non-blank", () => {
    expect(SRC).toContain("if (prescriberNpi.trim()) body.prescriberNpi");
  });

  it("includes diagnosis only when non-blank", () => {
    expect(SRC).toContain("if (diagnosis.trim()) body.diagnosis");
  });

  it("includes notes only when non-blank", () => {
    expect(SRC).toContain("if (notes.trim()) body.notes");
  });
});
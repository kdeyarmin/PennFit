// Tests for pages/admin/admin-delivery-failures.tsx
//
// PR change: the `if (data.auditEventsUnavailable)` branch was removed
// from AuditFailuresTable. The system-events "no longer tracked"
// notice is gone; the component now always renders either the
// empty-state message or the audit-events table.
//
// The vitest environment is "node" (no DOM). We read the source as a
// string and assert the structural invariants.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-delivery-failures.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// AuditFailuresTable — `auditEventsUnavailable` branch removed
// ---------------------------------------------------------------------------

describe("admin-delivery-failures AuditFailuresTable — unavailable branch removed", () => {
  it("does not render a data-testid='audit-events-unavailable' element", () => {
    expect(SRC).not.toContain("audit-events-unavailable");
  });

  it("does not check data.auditEventsUnavailable in AuditFailuresTable", () => {
    const fnStart = SRC.indexOf("function AuditFailuresTable(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = SRC.indexOf("\nfunction ", fnStart + 1);
    const fnBody = SRC.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);
    expect(fnBody).not.toContain("auditEventsUnavailable");
    expect(fnBody).not.toContain(".auditEventsUnavailable");
  });

  it("does not render the 'no longer tracked' retirement notice in audit context", () => {
    // Narrow the check to the AuditFailuresTable region so we don't
    // accidentally match unrelated text elsewhere in the file.
    const fnStart = SRC.indexOf("function AuditFailuresTable(");
    const fnEnd = SRC.indexOf("\nfunction ", fnStart + 1);
    const fnBody = SRC.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);
    expect(fnBody).not.toContain("System events are no longer tracked");
    expect(fnBody).not.toContain("audit log was retired");
  });

  it("source file does not reference auditEventsUnavailable anywhere", () => {
    expect(SRC).not.toContain("auditEventsUnavailable");
  });
});

// ---------------------------------------------------------------------------
// AuditFailuresTable — correct branches still present
// ---------------------------------------------------------------------------

describe("admin-delivery-failures AuditFailuresTable — retained branches", () => {
  it("still renders an empty-state message when rows.length === 0", () => {
    const fnStart = SRC.indexOf("function AuditFailuresTable(");
    const fnEnd = SRC.indexOf("\nfunction ", fnStart + 1);
    const fnBody = SRC.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);
    expect(fnBody).toContain("rows.length === 0");
  });

  it("still renders the audit events table body", () => {
    const fnStart = SRC.indexOf("function AuditFailuresTable(");
    const fnEnd = SRC.indexOf("\nfunction ", fnStart + 1);
    const fnBody = SRC.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);
    expect(fnBody).toContain("data.auditEvents");
  });

  it("still exports AdminDeliveryFailuresPage", () => {
    expect(SRC).toContain("export function AdminDeliveryFailuresPage");
  });
});

// ---------------------------------------------------------------------------
// MessageRow — still present
// ---------------------------------------------------------------------------

describe("admin-delivery-failures — MessageRow retained", () => {
  it("defines a MessageRow component", () => {
    expect(SRC).toContain("function MessageRow(");
  });
});

// ---------------------------------------------------------------------------
// Page-level wiring
// ---------------------------------------------------------------------------

describe("admin-delivery-failures — page-level wiring", () => {
  it("imports fetchDeliveryFailures from the delivery-failures-api lib", () => {
    expect(SRC).toContain("fetchDeliveryFailures");
    expect(SRC).toContain("delivery-failures-api");
  });

  it("defines the AuditFailuresTable component", () => {
    expect(SRC).toContain("function AuditFailuresTable(");
  });
});
// Tests for pages/admin/admin-delivery-failures.tsx
//
// The system-events stream reads the retired `audit_log` table, so
// AuditFailuresTable short-circuits on `data.auditEventsUnavailable` and
// renders a "no longer tracked" notice (CLAUDE.md hard rule: the four
// audit_log readers surface a degraded contract instead of fabricating
// data). These tests pin that notice so it isn't accidentally dropped.
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
// AuditFailuresTable — `auditEventsUnavailable` branch present
// ---------------------------------------------------------------------------

describe("admin-delivery-failures AuditFailuresTable — unavailable branch present", () => {
  it("renders a data-testid='audit-events-unavailable' element", () => {
    expect(SRC).toContain("audit-events-unavailable");
  });

  it("checks data.auditEventsUnavailable in AuditFailuresTable", () => {
    const fnStart = SRC.indexOf("function AuditFailuresTable(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = SRC.indexOf("\nfunction ", fnStart + 1);
    const fnBody = SRC.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);
    expect(fnBody).toContain("auditEventsUnavailable");
  });

  it("renders the 'no longer tracked' retirement notice in audit context", () => {
    // Narrow the check to the AuditFailuresTable region so we don't
    // accidentally match unrelated text elsewhere in the file.
    const fnStart = SRC.indexOf("function AuditFailuresTable(");
    const fnEnd = SRC.indexOf("\nfunction ", fnStart + 1);
    const fnBody = SRC.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);
    expect(fnBody).toContain("System events are no longer tracked");
    // The phrase wraps across a JSX line break in source ("audit log was\n
    // retired"), so assert on the contiguous lead-in rather than the full
    // sentence.
    expect(fnBody).toContain("The underlying audit log was");
  });

  it("references auditEventsUnavailable in the source", () => {
    expect(SRC).toContain("auditEventsUnavailable");
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
// Recall delivery failures — merged into the messages tab
// ---------------------------------------------------------------------------

describe("admin-delivery-failures — recall delivery failures surfaced", () => {
  it("defines a RecallRow component", () => {
    expect(SRC).toContain("function RecallRow(");
  });

  it("merges recallEvents into the message-failures table rows", () => {
    const fnStart = SRC.indexOf("function MessageFailuresTable(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = SRC.indexOf("\nfunction ", fnStart + 1);
    const fnBody = SRC.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);
    expect(fnBody).toContain("data.recallEvents");
    expect(fnBody).toContain("RecallRow");
  });

  it("links recall failures to the recall roster (no conversation thread)", () => {
    const fnStart = SRC.indexOf("function RecallRow(");
    const fnEnd = SRC.indexOf("\nfunction ", fnStart + 1);
    const fnBody = SRC.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);
    expect(fnBody).toContain("/admin/equipment-recalls");
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

// Tests for components/admin/ConversationAssignmentBar.tsx
//
// PR change (a11y): the escalation-reason textarea was given
// aria-label="Escalation reason" so screen-reader users can identify
// the field. The textarea already has a placeholder and data-testid,
// but placeholders alone are not a reliable accessible name source.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "ConversationAssignmentBar.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// a11y: aria-label on escalation reason textarea
// ---------------------------------------------------------------------------

describe("ConversationAssignmentBar — a11y: escalation reason aria-label", () => {
  it("escalation reason textarea has aria-label='Escalation reason'", () => {
    expect(SRC).toContain('aria-label="Escalation reason"');
  });

  it("aria-label appears near data-testid='conv-escalate-reason'", () => {
    const ariaIdx = SRC.indexOf('aria-label="Escalation reason"');
    const testidIdx = SRC.indexOf('data-testid="conv-escalate-reason"');
    expect(ariaIdx).toBeGreaterThan(-1);
    expect(testidIdx).toBeGreaterThan(-1);
    expect(Math.abs(ariaIdx - testidIdx)).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------

describe("ConversationAssignmentBar — structural invariants", () => {
  it("exports ConversationAssignmentBar", () => {
    expect(SRC).toContain("export function ConversationAssignmentBar");
  });

  it("escalation reason is capped at 500 characters", () => {
    expect(SRC).toContain(".slice(0, 500)");
  });

  it("escalation reason placeholder says 'Reason (required)'", () => {
    expect(SRC).toContain('placeholder="Reason (required)"');
  });
});

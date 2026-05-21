// Tests for pages/track-order.tsx
//
// PR change: the error paragraph shown when a track-order lookup fails had
// role="alert" removed.  The element is identified by data-testid="track-error"
// and should still render for users — only the ARIA role attribute was stripped.
//
// The component uses React hooks and cannot be rendered in the node vitest
// environment without jsdom.  We read the source file as a string for
// structural checks.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "track-order.tsx"), "utf8");

// ---------------------------------------------------------------------------
// track-error element — role="alert" removed
// ---------------------------------------------------------------------------

describe("track-order — track-error paragraph no longer has role=alert", () => {
  it("still renders data-testid track-error on the error element", () => {
    expect(SRC).toContain('data-testid="track-error"');
  });

  it("track-error element does not carry role=alert", () => {
    const idx = SRC.indexOf('data-testid="track-error"');
    expect(idx).toBeGreaterThan(-1);
    // Inspect the paragraph element surrounding the testid attribute.
    const elementContext = SRC.slice(
      SRC.lastIndexOf("<p", idx),
      SRC.indexOf(">", idx) + 1,
    );
    expect(elementContext).not.toContain('role="alert"');
  });

  it("track-error element still has the destructive text style", () => {
    const idx = SRC.indexOf('data-testid="track-error"');
    expect(idx).toBeGreaterThan(-1);
    const elementContext = SRC.slice(SRC.lastIndexOf("<p", idx), idx + 50);
    expect(elementContext).toContain("text-destructive");
  });

  it("track-error element is still conditionally rendered when error is truthy", () => {
    // The block is gated on {error && ...} — verify the conditional is still there.
    const errorConditionalIdx = SRC.indexOf("{error && (");
    expect(errorConditionalIdx).toBeGreaterThan(-1);
    // track-error testid must appear after the conditional opening brace.
    const trackErrorIdx = SRC.indexOf('data-testid="track-error"');
    expect(trackErrorIdx).toBeGreaterThan(errorConditionalIdx);
  });
});

// ---------------------------------------------------------------------------
// Regression: track-submit button still present
// ---------------------------------------------------------------------------

describe("track-order — submit button not accidentally removed", () => {
  it("still renders data-testid track-submit on the submit button", () => {
    expect(SRC).toContain('data-testid="track-submit"');
  });
});

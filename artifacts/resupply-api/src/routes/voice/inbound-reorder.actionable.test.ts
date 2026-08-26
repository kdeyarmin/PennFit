import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "inbound-reorder.ts"), "utf8");

describe("inbound-reorder actionable episode filter", () => {
  it("only binds in-progress episodes (not declined)", () => {
    expect(SRC).toMatch(
      /ACTIONABLE_EPISODE_STATUSES\s*=\s*\[\s*"outreach_pending",\s*"awaiting_response",?\s*\]/,
    );
    expect(SRC).not.toMatch(
      /ACTIONABLE_EPISODE_STATUSES\s*=\s*\[[^\]]*"declined"/,
    );
  });

  it("does not ask shop callers for a card on file", () => {
    expect(SRC).not.toMatch(/card on file/i);
  });
});

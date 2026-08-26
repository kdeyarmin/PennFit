// allow-source-read: ACTIONABLE_EPISODE_STATUSES is module-private and the
// inbound Twilio handler needs a signed webhook + DB to drive end-to-end;
// this pins the status allowlist (and no card-on-file shop copy) as a
// structural contract with no cheap behavioral harness.

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

  it("does not hard-code the seed Penn support dial target", () => {
    expect(SRC).not.toContain("+18144710627");
    expect(SRC).not.toContain("SUPPORT_DIAL_E164");
  });

  it("does not ask shop callers for a card on file", () => {
    expect(SRC).not.toMatch(/card on file/i);
  });

  it("does not run the retired cash-pay shop_customer voice agent", () => {
    expect(SRC).not.toContain('callerKind: "shop_customer"');
    expect(SRC).not.toContain("INBOUND_SHOP_CALL_CONTEXT");
  });

  it("routes shared-number calls by caller patient phone; never invents seed", () => {
    expect(SRC).toContain("resolveOrgIdByPatientPhone");
    expect(SRC).toMatch(
      /resolveOrgIdByCalledNumber[\s\S]*resolveOrgIdByPatientPhone/,
    );
    expect(SRC).not.toMatch(/resolveSeedOrgId/);
  });
});

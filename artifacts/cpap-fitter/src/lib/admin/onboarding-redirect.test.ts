import { describe, expect, it } from "vitest";

import { shouldRedirectToSetup } from "./onboarding-redirect";

const summary = (
  over: Partial<{
    requiredTotal: number;
    requiredDone: number;
    allRequiredDone: boolean;
  }>,
) => ({
  requiredTotal: 4,
  requiredDone: 0,
  allRequiredDone: false,
  ...over,
});

describe("shouldRedirectToSetup", () => {
  it("redirects a brand-new tenant that has configured nothing", () => {
    expect(shouldRedirectToSetup(summary({ requiredDone: 0 }), false)).toBe(
      true,
    );
  });

  it("does not redirect once the tenant has started setup", () => {
    expect(shouldRedirectToSetup(summary({ requiredDone: 1 }), false)).toBe(
      false,
    );
  });

  it("does not redirect an established (all-done) tenant", () => {
    expect(
      shouldRedirectToSetup(
        summary({ requiredDone: 4, allRequiredDone: true }),
        false,
      ),
    ).toBe(false);
  });

  it("does not redirect again once already redirected this session", () => {
    expect(shouldRedirectToSetup(summary({ requiredDone: 0 }), true)).toBe(
      false,
    );
  });

  it("does not redirect before the status has loaded", () => {
    expect(shouldRedirectToSetup(undefined, false)).toBe(false);
  });
});

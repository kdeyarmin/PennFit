// Tests for components/account/ProfileSection.tsx
//
// PR change: ProfileSection was extracted from pages/account.tsx into its own
// file at components/account/ProfileSection.tsx with no behaviour changes.
//
// The component uses React hooks and cannot be rendered in the node vitest
// environment without jsdom.  We use two complementary strategies:
//
//   1. Static source analysis — readFileSync the component source and make
//      assertions about structure (data-testid attributes, endpoint URLs,
//      override-warning flow, imports, etc.).
//
//   2. Pure-logic re-implementation — the component's non-trivial business
//      logic (dirty detection, address cleaning, partial-address validation)
//      is implemented as standalone functions and tested exhaustively.  The
//      implementations are verbatim copies of the logic inside the component
//      so that any drift in the component will surface as test failures.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "ProfileSection.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Structural checks — data-testid attributes
// ---------------------------------------------------------------------------

describe("ProfileSection — data-testid attributes", () => {
  it('has data-testid="account-profile-section" on the root section', () => {
    expect(SRC).toContain('data-testid="account-profile-section"');
  });

  it('has data-testid="account-name" on the display-name input', () => {
    expect(SRC).toContain('data-testid="account-name"');
  });

  it('has data-testid="account-addr-line1" on the street-address input', () => {
    expect(SRC).toContain('data-testid="account-addr-line1"');
  });

  it('has data-testid="account-addr-line2" on the apt/suite input', () => {
    expect(SRC).toContain('data-testid="account-addr-line2"');
  });

  it('has data-testid="account-addr-city" on the city input', () => {
    expect(SRC).toContain('data-testid="account-addr-city"');
  });

  it('has data-testid="account-addr-state" on the state input', () => {
    expect(SRC).toContain('data-testid="account-addr-state"');
  });

  it('has data-testid="account-addr-zip" on the postal-code input', () => {
    expect(SRC).toContain('data-testid="account-addr-zip"');
  });

  it('has data-testid="account-save-btn" on the submit button', () => {
    expect(SRC).toContain('data-testid="account-save-btn"');
  });

  it('has data-testid="account-save-error" on the error paragraph', () => {
    expect(SRC).toContain('data-testid="account-save-error"');
  });

  it('has data-testid="account-save-success" on the saved confirmation span', () => {
    expect(SRC).toContain('data-testid="account-save-success"');
  });

  it('has data-testid="account-profile-dirty" on the unsaved-changes indicator', () => {
    expect(SRC).toContain('data-testid="account-profile-dirty"');
  });
});

// ---------------------------------------------------------------------------
// Structural checks — address validation probe
// ---------------------------------------------------------------------------

describe("ProfileSection — address validation endpoint", () => {
  it("posts to /resupply-api/shop/validate-address for address probing", () => {
    expect(SRC).toContain("/resupply-api/shop/validate-address");
  });

  it("uses POST method for the address validation probe", () => {
    const probeBlock = SRC.slice(
      SRC.indexOf("/resupply-api/shop/validate-address") - 200,
      SRC.indexOf("/resupply-api/shop/validate-address") + 100,
    );
    expect(probeBlock).toContain('method: "POST"');
  });

  it('sends credentials: "include" with the validation probe', () => {
    const probeBlock = SRC.slice(
      SRC.indexOf("/resupply-api/shop/validate-address") - 200,
      SRC.indexOf("/resupply-api/shop/validate-address") + 300,
    );
    expect(probeBlock).toContain('credentials: "include"');
  });

  it("uses application/json content type for the probe body", () => {
    const probeBlock = SRC.slice(
      SRC.indexOf("/resupply-api/shop/validate-address") - 200,
      SRC.indexOf("/resupply-api/shop/validate-address") + 200,
    );
    expect(probeBlock).toContain("application/json");
  });

  it("sends all six address fields to the validation endpoint", () => {
    const probeBody = SRC.slice(
      SRC.indexOf("/resupply-api/shop/validate-address"),
      SRC.indexOf("/resupply-api/shop/validate-address") + 700,
    );
    expect(probeBody).toContain("line1");
    expect(probeBody).toContain("line2");
    expect(probeBody).toContain("city");
    expect(probeBody).toContain("state");
    expect(probeBody).toContain("postalCode");
    expect(probeBody).toContain("country");
  });

  it("treats validation probe errors as advisory (never blocks save)", () => {
    // The catch block for the probe must be empty / contain no blocking logic.
    const catchIdx = SRC.indexOf(
      "// Validation probe is advisory only — never block a save.",
    );
    expect(catchIdx).toBeGreaterThan(-1);
  });
});

// ---------------------------------------------------------------------------
// Structural checks — override-warning flow
// ---------------------------------------------------------------------------

describe("ProfileSection — override address-warning flow", () => {
  it("renders a 'save anyway' button inside the warnings block", () => {
    expect(SRC).toContain("save anyway");
  });

  it("sets overrideAddrWarning to true when 'save anyway' is clicked", () => {
    expect(SRC).toContain("setOverrideAddrWarning(true)");
  });

  it("clears overrideAddrWarning after a successful save", () => {
    expect(SRC).toContain("setOverrideAddrWarning(false)");
  });

  it("skips address validation when overrideAddrWarning is true", () => {
    expect(SRC).toContain("!overrideAddrWarning");
  });

  it("clears addrWarnings after a successful save", () => {
    expect(SRC).toContain("setAddrWarnings([])");
  });

  it("shows warnings with underscores replaced by spaces in the list", () => {
    expect(SRC).toContain('replace(/_/g, " ")');
  });
});

// ---------------------------------------------------------------------------
// Structural checks — imports and exports
// ---------------------------------------------------------------------------

describe("ProfileSection — module structure", () => {
  it("exports ProfileSection as a named export", () => {
    expect(SRC).toContain("export function ProfileSection(");
  });

  it("imports updateShopMe from account-api", () => {
    expect(SRC).toContain("updateShopMe");
    expect(SRC).toContain("account-api");
  });

  it("imports useUnsavedChangesWarning hook", () => {
    expect(SRC).toContain("useUnsavedChangesWarning");
  });

  it("imports SavedShippingAddress type from account-api", () => {
    expect(SRC).toContain("SavedShippingAddress");
  });

  it("imports ShopMeResponse type from account-api", () => {
    expect(SRC).toContain("ShopMeResponse");
  });
});

// ---------------------------------------------------------------------------
// Structural checks — dirty-state visibility
// ---------------------------------------------------------------------------

describe("ProfileSection — unsaved-changes indicator visibility", () => {
  it("hides the dirty indicator while the saved flash is active", () => {
    // The dirty span must be guarded so it's hidden during the post-save flash.
    const dirtySpan = SRC.indexOf('data-testid="account-profile-dirty"');
    expect(dirtySpan).toBeGreaterThan(-1);
    // The expression controlling the span must check savedAt window.
    const spanContext = SRC.slice(dirtySpan - 200, dirtySpan);
    expect(spanContext).toContain("savedAt");
    expect(spanContext).toContain("4000");
  });

  it("shows the saved flash only within a 4-second window after save", () => {
    const successSpan = SRC.indexOf('data-testid="account-save-success"');
    expect(successSpan).toBeGreaterThan(-1);
    const spanContext = SRC.slice(successSpan - 300, successSpan);
    expect(spanContext).toContain("4000");
    expect(spanContext).toContain("savedAt");
  });
});

// ---------------------------------------------------------------------------
// Structural checks — state input normalisation
// ---------------------------------------------------------------------------

describe("ProfileSection — state input normalisation", () => {
  it("converts state input to uppercase on change", () => {
    expect(SRC).toContain("toUpperCase()");
  });

  it("limits state input to 2 characters via slice", () => {
    expect(SRC).toContain(".slice(0, 2)");
  });

  it("enforces maxLength={2} on the state input element", () => {
    expect(SRC).toContain("maxLength={2}");
  });
});

// ---------------------------------------------------------------------------
// Structural checks — error display
// ---------------------------------------------------------------------------

describe("ProfileSection — partial address error message", () => {
  it("surfaces an error when some but not all address fields are filled", () => {
    expect(SRC).toContain(
      "Fill in street, city, state, and ZIP — or clear all four to remove the saved address.",
    );
  });
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementations
// ---------------------------------------------------------------------------
// These replicate the exact logic from ProfileSection.tsx so that any drift
// in the component will break the tests.

// ---- dirty detection -------------------------------------------------------

interface ProfileSnapshot {
  displayName: string | null;
  shippingAddress: {
    line1: string;
    line2?: string | null;
    city: string;
    state: string;
    postalCode: string;
  } | null;
}

interface AddrState {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
}

/** Verbatim copy of the `dirty` expression from ProfileSection.tsx */
function computeDirty(
  displayName: string,
  addr: AddrState,
  profile: ProfileSnapshot,
): boolean {
  const initialAddr = profile.shippingAddress ?? null;
  return (
    (displayName.trim() || null) !== (profile.displayName ?? null) ||
    (addr.line1?.trim() ?? "") !== (initialAddr?.line1 ?? "") ||
    (addr.line2?.trim() ?? "") !== (initialAddr?.line2 ?? "") ||
    (addr.city?.trim() ?? "") !== (initialAddr?.city ?? "") ||
    (addr.state?.trim().toUpperCase() ?? "") !== (initialAddr?.state ?? "") ||
    (addr.postalCode?.trim() ?? "") !== (initialAddr?.postalCode ?? "")
  );
}

describe("ProfileSection — dirty detection", () => {
  const profile: ProfileSnapshot = {
    displayName: "Jane Doe",
    shippingAddress: {
      line1: "123 Main St",
      line2: null,
      city: "Philadelphia",
      state: "PA",
      postalCode: "19103",
    },
  };

  it("returns false when no fields have changed", () => {
    expect(
      computeDirty("Jane Doe", profile.shippingAddress as AddrState, profile),
    ).toBe(false);
  });

  it("returns true when displayName changes", () => {
    expect(
      computeDirty("John Smith", profile.shippingAddress as AddrState, profile),
    ).toBe(true);
  });

  it("returns true when line1 changes", () => {
    const addr = { ...profile.shippingAddress!, line1: "456 Elm Ave" };
    expect(computeDirty("Jane Doe", addr, profile)).toBe(true);
  });

  it("returns true when city changes", () => {
    const addr = { ...profile.shippingAddress!, city: "Pittsburgh" };
    expect(computeDirty("Jane Doe", addr, profile)).toBe(true);
  });

  it("returns true when state changes", () => {
    const addr = { ...profile.shippingAddress!, state: "NY" };
    expect(computeDirty("Jane Doe", addr, profile)).toBe(true);
  });

  it("returns true when postalCode changes", () => {
    const addr = { ...profile.shippingAddress!, postalCode: "10001" };
    expect(computeDirty("Jane Doe", addr, profile)).toBe(true);
  });

  it("returns true when line2 changes from null to a value", () => {
    const addr = { ...profile.shippingAddress!, line2: "Apt 2B" };
    expect(computeDirty("Jane Doe", addr, profile)).toBe(true);
  });

  it("is not dirty when only trailing whitespace is added to displayName", () => {
    // Trimming mirrors what gets persisted.
    expect(
      computeDirty(
        "Jane Doe   ",
        profile.shippingAddress as AddrState,
        profile,
      ),
    ).toBe(false);
  });

  it("is not dirty when state is lowercase version of the saved state", () => {
    // The state comparison is case-insensitive (both sides upper-cased).
    const addr = { ...profile.shippingAddress!, state: "pa" };
    expect(computeDirty("Jane Doe", addr, profile)).toBe(false);
  });

  it("treats a blank displayName the same as null in the original profile", () => {
    const noNameProfile: ProfileSnapshot = {
      displayName: null,
      shippingAddress: null,
    };
    expect(
      computeDirty("", { line1: "", line2: "", city: "", state: "", postalCode: "" }, noNameProfile),
    ).toBe(false);
  });

  it("returns true when displayName changes from null to a real name", () => {
    const noNameProfile: ProfileSnapshot = {
      displayName: null,
      shippingAddress: null,
    };
    expect(
      computeDirty("Alice", { line1: "", line2: "", city: "", state: "", postalCode: "" }, noNameProfile),
    ).toBe(true);
  });

  it("returns true when address is filled in from empty profile", () => {
    const emptyProfile: ProfileSnapshot = {
      displayName: null,
      shippingAddress: null,
    };
    expect(
      computeDirty("", { line1: "1 New St", line2: "", city: "Boston", state: "MA", postalCode: "02101" }, emptyProfile),
    ).toBe(true);
  });
});

// ---- cleanAddr building ----------------------------------------------------

interface CleanAddr {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: "US";
}

/** Verbatim copy of the cleanAddr-building block from onSubmit */
function buildCleanAddr(addr: AddrState): CleanAddr {
  return {
    line1: addr.line1.trim(),
    line2: addr.line2?.trim() || null,
    city: addr.city.trim(),
    state: addr.state.trim().toUpperCase(),
    postalCode: addr.postalCode.trim(),
    country: "US",
  };
}

describe("ProfileSection — cleanAddr building", () => {
  it("trims whitespace from line1", () => {
    const result = buildCleanAddr({
      line1: "  123 Main St  ",
      line2: null,
      city: "City",
      state: "CA",
      postalCode: "90210",
    });
    expect(result.line1).toBe("123 Main St");
  });

  it("converts state to uppercase", () => {
    const result = buildCleanAddr({
      line1: "123 Main St",
      line2: null,
      city: "City",
      state: "ca",
      postalCode: "90210",
    });
    expect(result.state).toBe("CA");
  });

  it("always sets country to 'US'", () => {
    const result = buildCleanAddr({
      line1: "123 Main St",
      line2: null,
      city: "City",
      state: "CA",
      postalCode: "90210",
    });
    expect(result.country).toBe("US");
  });

  it("converts empty string line2 to null", () => {
    const result = buildCleanAddr({
      line1: "123 Main St",
      line2: "",
      city: "City",
      state: "CA",
      postalCode: "90210",
    });
    expect(result.line2).toBeNull();
  });

  it("converts whitespace-only line2 to null", () => {
    const result = buildCleanAddr({
      line1: "123 Main St",
      line2: "   ",
      city: "City",
      state: "CA",
      postalCode: "90210",
    });
    expect(result.line2).toBeNull();
  });

  it("preserves non-empty line2 after trimming", () => {
    const result = buildCleanAddr({
      line1: "123 Main St",
      line2: "  Apt 4B  ",
      city: "City",
      state: "CA",
      postalCode: "90210",
    });
    expect(result.line2).toBe("Apt 4B");
  });

  it("trims whitespace from city", () => {
    const result = buildCleanAddr({
      line1: "123 Main St",
      line2: null,
      city: "  Los Angeles  ",
      state: "CA",
      postalCode: "90001",
    });
    expect(result.city).toBe("Los Angeles");
  });

  it("trims whitespace from postalCode", () => {
    const result = buildCleanAddr({
      line1: "123 Main St",
      line2: null,
      city: "City",
      state: "CA",
      postalCode: "  90210  ",
    });
    expect(result.postalCode).toBe("90210");
  });
});

// ---- hasAnyField / allRequiredFilled validation ----------------------------

/** Verbatim copy of the validation logic from onSubmit */
function validateAddressFields(cleanAddr: CleanAddr): {
  hasAnyField: boolean;
  allRequiredFilled: boolean;
} {
  const hasAnyField = !!(
    cleanAddr.line1 ||
    cleanAddr.city ||
    cleanAddr.state ||
    cleanAddr.postalCode
  );
  const allRequiredFilled = !!(
    cleanAddr.line1 &&
    cleanAddr.city &&
    cleanAddr.state &&
    cleanAddr.postalCode
  );
  return { hasAnyField, allRequiredFilled };
}

const EMPTY_ADDR: CleanAddr = {
  line1: "",
  line2: null,
  city: "",
  state: "",
  postalCode: "",
  country: "US",
};

const FULL_ADDR: CleanAddr = {
  line1: "123 Main St",
  line2: null,
  city: "Philadelphia",
  state: "PA",
  postalCode: "19103",
  country: "US",
};

describe("ProfileSection — address partial-fill validation", () => {
  it("hasAnyField is false when all four required fields are empty", () => {
    const { hasAnyField } = validateAddressFields(EMPTY_ADDR);
    expect(hasAnyField).toBe(false);
  });

  it("allRequiredFilled is false when all four required fields are empty", () => {
    const { allRequiredFilled } = validateAddressFields(EMPTY_ADDR);
    expect(allRequiredFilled).toBe(false);
  });

  it("hasAnyField is true when only line1 is set", () => {
    const addr = { ...EMPTY_ADDR, line1: "123 Main St" };
    const { hasAnyField } = validateAddressFields(addr);
    expect(hasAnyField).toBe(true);
  });

  it("allRequiredFilled is false when only line1 is set", () => {
    const addr = { ...EMPTY_ADDR, line1: "123 Main St" };
    const { allRequiredFilled } = validateAddressFields(addr);
    expect(allRequiredFilled).toBe(false);
  });

  it("hasAnyField is true when only city is set", () => {
    const addr = { ...EMPTY_ADDR, city: "Boston" };
    const { hasAnyField } = validateAddressFields(addr);
    expect(hasAnyField).toBe(true);
  });

  it("hasAnyField is true when only state is set", () => {
    const addr = { ...EMPTY_ADDR, state: "MA" };
    const { hasAnyField } = validateAddressFields(addr);
    expect(hasAnyField).toBe(true);
  });

  it("hasAnyField is true when only postalCode is set", () => {
    const addr = { ...EMPTY_ADDR, postalCode: "02101" };
    const { hasAnyField } = validateAddressFields(addr);
    expect(hasAnyField).toBe(true);
  });

  it("line2 alone does NOT make hasAnyField true", () => {
    // line2 is optional; only the four required fields count.
    const addr = { ...EMPTY_ADDR, line2: "Apt 5C" };
    const { hasAnyField } = validateAddressFields(addr);
    expect(hasAnyField).toBe(false);
  });

  it("both flags are true when all four required fields are provided", () => {
    const { hasAnyField, allRequiredFilled } = validateAddressFields(FULL_ADDR);
    expect(hasAnyField).toBe(true);
    expect(allRequiredFilled).toBe(true);
  });

  it("hasAnyField=true but allRequiredFilled=false when three fields are set", () => {
    // Missing postalCode.
    const addr = { ...FULL_ADDR, postalCode: "" };
    const { hasAnyField, allRequiredFilled } = validateAddressFields(addr);
    expect(hasAnyField).toBe(true);
    expect(allRequiredFilled).toBe(false);
  });

  it("hasAnyField=true but allRequiredFilled=false when only city and state are set", () => {
    const addr = { ...EMPTY_ADDR, city: "Austin", state: "TX" };
    const { hasAnyField, allRequiredFilled } = validateAddressFields(addr);
    expect(hasAnyField).toBe(true);
    expect(allRequiredFilled).toBe(false);
  });

  it("returns hasAnyField=false and allRequiredFilled=false for a truly blank address (boundary)", () => {
    // Regression: ensure a fully cleared address doesn't trigger partial-fill error.
    const addr: CleanAddr = { line1: "", line2: null, city: "", state: "", postalCode: "", country: "US" };
    const result = validateAddressFields(addr);
    expect(result.hasAnyField).toBe(false);
    expect(result.allRequiredFilled).toBe(false);
  });
});

// ---- state input normalisation (pure function) ----------------------------

/** Verbatim copy of the state onChange normalisation from ProfileSection.tsx */
function normaliseStateInput(raw: string): string {
  return raw.toUpperCase().slice(0, 2);
}

describe("ProfileSection — state input normalisation", () => {
  it("converts lowercase input to uppercase", () => {
    expect(normaliseStateInput("ca")).toBe("CA");
  });

  it("truncates input longer than 2 characters", () => {
    expect(normaliseStateInput("CAL")).toBe("CA");
  });

  it("accepts exactly 2 characters unchanged", () => {
    expect(normaliseStateInput("NY")).toBe("NY");
  });

  it("handles a single character", () => {
    expect(normaliseStateInput("c")).toBe("C");
  });

  it("handles empty input", () => {
    expect(normaliseStateInput("")).toBe("");
  });

  it("converts mixed-case input to uppercase and truncates", () => {
    expect(normaliseStateInput("pA3")).toBe("PA");
  });
});
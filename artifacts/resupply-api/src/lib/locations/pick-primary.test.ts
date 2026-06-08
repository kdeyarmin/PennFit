import { describe, it, expect } from "vitest";

import { pickPrimaryLocation } from "./pick-primary";

const loc = (
  over: Partial<{ id: string; is_primary: boolean; is_active: boolean }>,
) => ({
  id: "l",
  is_primary: false,
  is_active: true,
  ...over,
});

describe("pickPrimaryLocation", () => {
  it("returns the explicit primary when set", () => {
    const p = pickPrimaryLocation([
      loc({ id: "a" }),
      loc({ id: "b", is_primary: true }),
    ]);
    expect(p?.id).toBe("b");
  });
  it("falls back to the first active when no primary", () => {
    const p = pickPrimaryLocation([
      loc({ id: "a", is_active: false }),
      loc({ id: "b", is_active: true }),
    ]);
    expect(p?.id).toBe("b");
  });
  it("falls back to the first row when none active, and null when empty", () => {
    expect(pickPrimaryLocation([loc({ id: "a", is_active: false })])?.id).toBe(
      "a",
    );
    expect(pickPrimaryLocation([])).toBeNull();
  });
});

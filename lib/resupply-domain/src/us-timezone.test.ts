import { describe, expect, it } from "vitest";

import { timezoneForUsState } from "./us-timezone";

describe("timezoneForUsState", () => {
  it("maps USPS codes to their dominant zone, case-insensitively", () => {
    expect(timezoneForUsState("PA")).toBe("America/New_York");
    expect(timezoneForUsState("ca")).toBe("America/Los_Angeles");
    expect(timezoneForUsState("Tx")).toBe("America/Chicago");
    expect(timezoneForUsState("CO")).toBe("America/Denver");
    expect(timezoneForUsState("AK")).toBe("America/Anchorage");
    expect(timezoneForUsState("HI")).toBe("Pacific/Honolulu");
  });

  it("gives Arizona its own no-DST zone", () => {
    expect(timezoneForUsState("AZ")).toBe("America/Phoenix");
  });

  it("accepts full state names with sloppy casing/whitespace", () => {
    expect(timezoneForUsState("Pennsylvania")).toBe("America/New_York");
    expect(timezoneForUsState("  new   york ")).toBe("America/New_York");
    expect(timezoneForUsState("WEST VIRGINIA")).toBe("America/New_York");
    expect(timezoneForUsState("california")).toBe("America/Los_Angeles");
  });

  it("returns null for unknown or empty input rather than guessing", () => {
    expect(timezoneForUsState(null)).toBeNull();
    expect(timezoneForUsState(undefined)).toBeNull();
    expect(timezoneForUsState("")).toBeNull();
    expect(timezoneForUsState("ZZ")).toBeNull();
    expect(timezoneForUsState("Ontario")).toBeNull();
  });

  it("maps split states to their dominant side", () => {
    expect(timezoneForUsState("TN")).toBe("America/Chicago");
    expect(timezoneForUsState("KY")).toBe("America/New_York");
    expect(timezoneForUsState("IN")).toBe("America/New_York");
    expect(timezoneForUsState("OR")).toBe("America/Los_Angeles");
    expect(timezoneForUsState("ID")).toBe("America/Denver");
  });
});

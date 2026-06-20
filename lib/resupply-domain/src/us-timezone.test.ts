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

  it("maps US territories", () => {
    expect(timezoneForUsState("PR")).toBe("America/Puerto_Rico");
    expect(timezoneForUsState("VI")).toBe("America/St_Thomas");
    expect(timezoneForUsState("GU")).toBe("Pacific/Guam");
    expect(timezoneForUsState("MP")).toBe("Pacific/Guam");
    expect(timezoneForUsState("AS")).toBe("Pacific/Pago_Pago");
    expect(timezoneForUsState("Northern Mariana Islands")).toBe("Pacific/Guam");
  });

  describe("ZIP refinement for split states", () => {
    it("refines the minor side to the correct zone", () => {
      expect(timezoneForUsState("TN", "37902")).toBe("America/New_York"); // Knoxville
      expect(timezoneForUsState("KY", "42101")).toBe("America/Chicago"); // Bowling Green
      expect(timezoneForUsState("FL", "32501")).toBe("America/Chicago"); // Pensacola
      expect(timezoneForUsState("TX", "79901")).toBe("America/Denver"); // El Paso
      expect(timezoneForUsState("ID", "83814")).toBe("America/Los_Angeles"); // Coeur d'Alene
    });

    it("keeps the state zone for a major-side or unlisted ZIP", () => {
      expect(timezoneForUsState("TN", "37201")).toBe("America/Chicago"); // Nashville
      expect(timezoneForUsState("KY", "40502")).toBe("America/New_York"); // Lexington
      expect(timezoneForUsState("FL", "33101")).toBe("America/New_York"); // Miami
    });

    it("ignores a zip for a non-split state and tolerates junk", () => {
      expect(timezoneForUsState("PA", "19104")).toBe("America/New_York");
      expect(timezoneForUsState("TN", "")).toBe("America/Chicago");
      expect(timezoneForUsState("TN", "xx")).toBe("America/Chicago");
      expect(timezoneForUsState("TN", null)).toBe("America/Chicago");
    });
  });
});

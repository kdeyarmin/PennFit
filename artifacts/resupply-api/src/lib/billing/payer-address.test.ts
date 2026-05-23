import { describe, expect, it } from "vitest";

import {
  formatPostalAddressLines,
  parsePayerAddressLines,
  parsePostalAddress,
} from "./payer-address";

describe("parsePostalAddress", () => {
  it("returns null for non-object inputs", () => {
    expect(parsePostalAddress(null)).toBeNull();
    expect(parsePostalAddress(undefined)).toBeNull();
    expect(parsePostalAddress("string")).toBeNull();
    expect(parsePostalAddress(42)).toBeNull();
  });

  it("returns null when any required field is missing or blank", () => {
    expect(parsePostalAddress({})).toBeNull();
    expect(
      parsePostalAddress({ line1: "1 Main", city: "Pgh", state: "PA" }),
    ).toBeNull();
    expect(
      parsePostalAddress({
        line1: "",
        city: "Pgh",
        state: "PA",
        zip: "15213",
      }),
    ).toBeNull();
    expect(
      parsePostalAddress({
        line1: "  ",
        city: "Pgh",
        state: "PA",
        zip: "15213",
      }),
    ).toBeNull();
  });

  it("parses the minimum-fields shape", () => {
    expect(
      parsePostalAddress({
        line1: "P.O. Box 41420",
        city: "Philadelphia",
        state: "PA",
        zip: "19101",
      }),
    ).toEqual({
      line1: "P.O. Box 41420",
      line2: null,
      line3: null,
      city: "Philadelphia",
      state: "PA",
      zip: "19101",
    });
  });

  it("preserves line2 and line3 when present", () => {
    expect(
      parsePostalAddress({
        line1: "UPMC for You Appeals",
        line2: "U.S. Steel Tower",
        line3: "600 Grant Street",
        city: "Pittsburgh",
        state: "PA",
        zip: "15219",
      }),
    ).toEqual({
      line1: "UPMC for You Appeals",
      line2: "U.S. Steel Tower",
      line3: "600 Grant Street",
      city: "Pittsburgh",
      state: "PA",
      zip: "15219",
    });
  });

  it("trims whitespace from string fields", () => {
    expect(
      parsePostalAddress({
        line1: "  P.O. Box 1  ",
        city: " Pittsburgh ",
        state: "PA",
        zip: " 15213 ",
      }),
    ).toMatchObject({
      line1: "P.O. Box 1",
      city: "Pittsburgh",
      zip: "15213",
    });
  });

  it("treats whitespace-only optional lines as missing", () => {
    expect(
      parsePostalAddress({
        line1: "1 Main",
        line2: "   ",
        city: "Pgh",
        state: "PA",
        zip: "15213",
      }),
    ).toMatchObject({ line2: null });
  });
});

describe("formatPostalAddressLines", () => {
  it("emits the minimum two lines", () => {
    expect(
      formatPostalAddressLines({
        line1: "P.O. Box 41420",
        city: "Philadelphia",
        state: "PA",
        zip: "19101",
      }),
    ).toEqual(["P.O. Box 41420", "Philadelphia, PA 19101"]);
  });

  it("appends line2 + line3 in order", () => {
    expect(
      formatPostalAddressLines({
        line1: "UPMC Appeals",
        line2: "U.S. Steel Tower",
        line3: "600 Grant Street",
        city: "Pittsburgh",
        state: "PA",
        zip: "15219",
      }),
    ).toEqual([
      "UPMC Appeals",
      "U.S. Steel Tower",
      "600 Grant Street",
      "Pittsburgh, PA 15219",
    ]);
  });
});

describe("parsePayerAddressLines", () => {
  it("round-trips parse + format", () => {
    expect(
      parsePayerAddressLines({
        line1: "P.O. Box 535047",
        city: "Pittsburgh",
        state: "PA",
        zip: "15253",
      }),
    ).toEqual(["P.O. Box 535047", "Pittsburgh, PA 15253"]);
  });

  it("returns null on malformed input", () => {
    expect(parsePayerAddressLines({ line1: "x" })).toBeNull();
  });
});

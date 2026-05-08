import { describe, expect, it } from "vitest";

import { isAsciiOnly } from "./sms";

describe("isAsciiOnly", () => {
  it("returns true for plain ASCII text", () => {
    expect(isAsciiOnly("Hello, this is segment-safe SMS text 123.")).toBe(true);
  });

  it("returns false when any non-ASCII character is present", () => {
    expect(isAsciiOnly("hello — em dash")).toBe(false);
    expect(isAsciiOnly("curly quote: ’")).toBe(false);
  });
});

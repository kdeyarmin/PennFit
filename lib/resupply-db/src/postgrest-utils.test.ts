import { describe, expect, it } from "vitest";

import { escapePostgRESTFilterValue } from "./postgrest-utils";

describe("escapePostgRESTFilterValue", () => {
  it("leaves a plain value untouched", () => {
    expect(escapePostgRESTFilterValue("hello")).toBe("hello");
    expect(escapePostgRESTFilterValue("jane@example.com")).toBe(
      "jane@example.com",
    );
  });

  it("backslash-escapes LIKE wildcards so an ilike value matches literally", () => {
    // Regression: `%` / `_` were passed through and acted as wildcards,
    // so an email like a%b@x.com matched a<anything>b@x.com (wrong-row
    // match for the fitter-lead email matchers + admin search).
    expect(escapePostgRESTFilterValue("a%b@x.com")).toBe("a\\%b@x.com");
    expect(escapePostgRESTFilterValue("a_b@x.com")).toBe("a\\_b@x.com");
    // The result must not contain an UN-escaped wildcard.
    expect(escapePostgRESTFilterValue("100%_off")).toBe("100\\%\\_off");
  });

  it("escapes a literal backslash (the LIKE escape char)", () => {
    // "a\\b" is the 3-char string a\b → a\\b (escaped).
    expect(escapePostgRESTFilterValue("a\\b")).toBe("a\\\\b");
  });

  it("wraps values containing .or() clause delimiters in quotes", () => {
    expect(escapePostgRESTFilterValue("Smith, John")).toBe('"Smith, John"');
    expect(escapePostgRESTFilterValue("a(b)c")).toBe('"a(b)c"');
    // Embedded double-quote is escaped inside the wrapping quotes.
    expect(escapePostgRESTFilterValue('say "hi", bye')).toBe(
      '"say \\"hi\\", bye"',
    );
  });

  it("composes both layers: a wildcard AND a delimiter", () => {
    // step1 (LIKE): a%b, c → a\%b, c ; step2 (quote, re-escape \): "a\\%b, c"
    expect(escapePostgRESTFilterValue("a%b, c")).toBe('"a\\\\%b, c"');
  });
});

import { describe, expect, it } from "vitest";

import {
  escapePostgRESTContainsPattern,
  escapePostgRESTFilterValue,
} from "./postgrest-utils";

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

describe("escapePostgRESTContainsPattern", () => {
  it("wraps a plain value in * wildcards, unquoted", () => {
    expect(escapePostgRESTContainsPattern("smith")).toBe("*smith*");
  });

  it("escapes LIKE wildcards inside the pattern", () => {
    expect(escapePostgRESTContainsPattern("100%_off")).toBe("*100\\%\\_off*");
  });

  it("puts the * wildcards INSIDE the quotes for delimiter-containing values", () => {
    // Regression: composing `*${escapePostgRESTFilterValue(v)}*` put
    // the leading * BEFORE the opening quote — PostgREST's logic-tree
    // parser only honors quoting when the quote is the operand's first
    // character, so `name.ilike.*"Smith, John"*` mis-parsed (the comma
    // terminated the operand → PostgREST 400 → admin search 500) for
    // exactly the inputs the quoting was meant to protect.
    expect(escapePostgRESTContainsPattern("Smith, John")).toBe(
      '"*Smith, John*"',
    );
    expect(escapePostgRESTContainsPattern("(albert)")).toBe('"*(albert)*"');
    expect(escapePostgRESTContainsPattern('say "hi"')).toBe('"*say \\"hi\\"*"');
  });

  it("never emits a quote that is not the first character", () => {
    for (const input of ["Smith, John", "(x)", 'a"b', "plain", "100%"]) {
      const out = escapePostgRESTContainsPattern(input);
      if (out.includes('"')) {
        expect(out.startsWith('"')).toBe(true);
        expect(out.endsWith('"')).toBe(true);
      }
    }
  });
});

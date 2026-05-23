// Tests for pages/order.tsx
//
// PR changes:
//   * Double-submit guard in onSubmit: `if (isPending) return;` added at the
//     very top of the react-hook-form submit handler so a fast double-click
//     that fires two onSubmit calls before React re-renders doesn't send two
//     API requests.
//
// The component uses React + hooks which cannot be rendered in the node
// vitest environment without jsdom. We read the source file as a string for
// structural checks, and additionally test the formatUsPhone helper inline
// since it is a pure function whose behaviour is straightforward to verify.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "order.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Double-submit guard — structural check
// ---------------------------------------------------------------------------
describe("order — double-submit guard in onSubmit", () => {
  it("includes the isPending guard at the top of the submit handler", () => {
    expect(SRC).toContain("if (isPending) return;");
  });

  it("places the isPending guard before the honeypot check", () => {
    const guardIdx = SRC.indexOf("if (isPending) return;");
    const honeypotIdx = SRC.indexOf("values.website");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(honeypotIdx).toBeGreaterThan(guardIdx);
  });

  it("places the isPending guard before mutate() call", () => {
    const guardIdx = SRC.indexOf("if (isPending) return;");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    // The actual mutate call uses a newline before the args block —
    // `mutate(\n      {`. Match that pattern to skip past comments that
    // contain bare "mutate()" mentions.
    const mutateIdx = SRC.search(/\bmutate\(\s*\n\s+\{/);
    expect(mutateIdx).toBeGreaterThan(guardIdx);
  });

  it("also disables the submit button while isPending for UI feedback", () => {
    expect(SRC).toContain("disabled={isPending}");
  });

  it("explains the race condition in a comment so the guard is not removed inadvertently", () => {
    expect(SRC).toMatch(/double.click|double-click/i);
    expect(SRC).toContain("isPending");
  });
});

// ---------------------------------------------------------------------------
// Honeypot — still present (regression)
// ---------------------------------------------------------------------------
describe("order — honeypot field still present", () => {
  it("checks values.website to detect bot submissions", () => {
    expect(SRC).toContain("values.website");
  });

  it("silently fakes success for bots rather than hitting the API", () => {
    expect(SRC).toContain("PENN-FAKE");
  });

  it("uses aria-hidden to hide the honeypot from screen readers", () => {
    expect(SRC).toContain(`aria-hidden="true"`);
  });

  it("uses tabIndex=-1 to exclude the honeypot from keyboard navigation", () => {
    expect(SRC).toContain("tabIndex={-1}");
  });
});

// ---------------------------------------------------------------------------
// formatUsPhone — pure-function unit tests (re-implemented inline)
// ---------------------------------------------------------------------------
// The helper is private to the module. To give solid behavioural coverage
// without a DOM, we re-implement it verbatim and test the contract the PR
// relies on (the function is unchanged in this PR but is exercised by the
// changed submit path, so testing it here documents expected behaviour).

function formatUsPhone(input: string): string {
  if (!input) return "";
  if (input.trim().startsWith("+")) return input;
  const digits = input.replace(/\D/g, "");
  if (digits.length === 0) return "";
  const local =
    digits.length === 11 && digits.startsWith("1")
      ? digits.slice(1)
      : digits.slice(0, 10);
  if (local.length < 4) return `(${local}`;
  if (local.length < 7) return `(${local.slice(0, 3)}) ${local.slice(3)}`;
  return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6, 10)}`;
}

describe("formatUsPhone — empty / blank inputs", () => {
  it("returns empty string for empty input", () => {
    expect(formatUsPhone("")).toBe("");
  });

  it("returns empty string for a string of only non-digit characters", () => {
    expect(formatUsPhone("abc")).toBe("");
  });
});

describe("formatUsPhone — international prefix passthrough", () => {
  it("returns the input unchanged when it starts with '+'", () => {
    expect(formatUsPhone("+44 20 7946 0958")).toBe("+44 20 7946 0958");
  });

  it("also passes through leading +1 numbers unchanged (treat as intl)", () => {
    expect(formatUsPhone("+15551234567")).toBe("+15551234567");
  });
});

describe("formatUsPhone — progressive formatting of 10-digit US numbers", () => {
  it("wraps a single digit in an open paren", () => {
    expect(formatUsPhone("5")).toBe("(5");
  });

  it("wraps two digits in an open paren", () => {
    expect(formatUsPhone("55")).toBe("(55");
  });

  it("wraps three digits in an open paren (area code)", () => {
    expect(formatUsPhone("555")).toBe("(555");
  });

  it("adds closing paren and space after the area code on the 4th digit", () => {
    expect(formatUsPhone("5551")).toBe("(555) 1");
  });

  it("formats 6-digit local number correctly", () => {
    expect(formatUsPhone("555123")).toBe("(555) 123");
  });

  it("inserts a hyphen after the 7th digit", () => {
    expect(formatUsPhone("5551234")).toBe("(555) 123-4");
  });

  it("formats a full 10-digit US number", () => {
    expect(formatUsPhone("5551234567")).toBe("(555) 123-4567");
  });

  it("strips non-digit characters before formatting", () => {
    expect(formatUsPhone("(555) 123-4567")).toBe("(555) 123-4567");
  });

  it("strips dashes from a raw 10-digit input", () => {
    expect(formatUsPhone("555-123-4567")).toBe("(555) 123-4567");
  });
});

describe("formatUsPhone — 11-digit numbers with leading '1' country code", () => {
  it("drops the leading 1 and formats as 10-digit US", () => {
    expect(formatUsPhone("15551234567")).toBe("(555) 123-4567");
  });

  it("only drops the leading 1 when the total length is exactly 11", () => {
    // A 12-digit number that starts with 1 is not treated as +1 country-code.
    expect(formatUsPhone("155512345678")).toBe("(155) 512-3456");
  });
});

describe("formatUsPhone — boundary: 10-digit truncation", () => {
  it("truncates to the first 10 local digits when more are provided", () => {
    // 13 digits that don't start with 1 → take first 10.
    expect(formatUsPhone("9991234567890")).toBe("(999) 123-4567");
  });
});

// ---------------------------------------------------------------------------
// PR change: role="alert" removed from consent-to-contact error paragraph
// ---------------------------------------------------------------------------
// The consentToContact error message element had role="alert" stripped in
// this PR. We verify the structural change so the attribute doesn't
// inadvertently creep back in.

describe("order — consentToContact error paragraph does not have role=alert", () => {
  it("still renders the consentToContact error conditionally", () => {
    // The conditional rendering block must still be present.
    expect(SRC).toContain("errors.consentToContact");
  });

  it("consentToContact error paragraph no longer carries role=alert", () => {
    const idx = SRC.indexOf("errors.consentToContact.message");
    expect(idx).toBeGreaterThan(-1);
    // Inspect the paragraph element that wraps the error message.
    const elementContext = SRC.slice(idx - 150, idx + 50);
    expect(elementContext).not.toContain('role="alert"');
  });

  it("consentToContact error paragraph still has the destructive text style", () => {
    const idx = SRC.indexOf("errors.consentToContact.message");
    expect(idx).toBeGreaterThan(-1);
    const elementContext = SRC.slice(idx - 150, idx + 50);
    expect(elementContext).toContain("text-destructive");
  });
});

// ---------------------------------------------------------------------------
// PR change: consent checkbox restored — form structure reverted
// ---------------------------------------------------------------------------
// The PR reverts a previous change that had auto-set consentToContact=true
// and removed the checkbox. The checkbox is now back, defaulting to false,
// and the field uses z.boolean().refine() so setValue(false) works without casts.

describe("order — consent checkbox restored (reversion)", () => {
  it("imports Checkbox from @/components/ui/checkbox", () => {
    expect(SRC).toContain('from "@/components/ui/checkbox"');
    expect(SRC).toContain("Checkbox");
  });

  it("renders the consent checkbox with data-testid='checkbox-consent'", () => {
    expect(SRC).toContain('data-testid="checkbox-consent"');
  });

  it("defaults consentToContact to false (requires an explicit checkbox tick)", () => {
    expect(SRC).toMatch(/consentToContact:\s*false/);
  });

  it("watches the consentToContact field value (consentValue)", () => {
    expect(SRC).toContain('watch("consentToContact")');
  });

  it("includes isSubmitted in the formState destructure (gates error display)", () => {
    expect(SRC).toContain("isSubmitted");
    expect(SRC).toMatch(/formState:\s*\{[^}]*isSubmitted/);
  });

  it("formSchema uses z.boolean().refine() — not z.literal(true)", () => {
    // z.literal(true) would prevent setValue("consentToContact", false) without casts.
    expect(SRC).toContain("z.boolean().refine(");
    expect(SRC).not.toContain("z.literal(true)");
  });

  it("refine message matches 'You must consent to be contacted'", () => {
    expect(SRC).toContain("You must consent to be contacted to submit an order");
  });

  it("renders the error conditionally on isSubmitted && errors.consentToContact", () => {
    expect(SRC).toContain("isSubmitted && errors.consentToContact");
  });
});

// ---------------------------------------------------------------------------
// PR change: account-prefill code removed (P3 reversal)
// ---------------------------------------------------------------------------
// The /shop/me prefill and splitDisplayName export were removed in this PR.

describe("order — prefill from /shop/me removed", () => {
  it("does not import fetchShopMe", () => {
    expect(SRC).not.toContain("fetchShopMe");
  });

  it("does not import useShopIdentity", () => {
    expect(SRC).not.toContain("useShopIdentity");
  });

  it("does not define or export splitDisplayName", () => {
    // splitDisplayName was exported for testability in the P3 branch.
    expect(SRC).not.toContain("splitDisplayName");
  });

  it("does not render the prefilled-hint banner", () => {
    expect(SRC).not.toContain('data-testid="order-prefilled-hint"');
    expect(SRC).not.toContain("Pre-filled from your account");
  });

  it("does not have the prefilledFromAccount state variable", () => {
    expect(SRC).not.toContain("prefilledFromAccount");
  });
});
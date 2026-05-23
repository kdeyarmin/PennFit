// Generic X12 segment tokenizer. Same delimiters as the 837P builder
// (`*` element separator, `~` segment terminator, `:` component
// separator) but flexible enough to read inbound files whose ISA line
// declares different separators — we honour ISA16 for the component
// separator and the byte after ISA's 16th element for the segment
// terminator.
//
// PHI posture: parser surface returns raw strings; callers MUST NOT
// log the parsed structures wholesale.

export interface Segment {
  id: string;
  /** Elements 1..N. The segment id is NOT included here. */
  elements: string[];
}

export interface ParsedX12 {
  segments: Segment[];
  delimiters: {
    element: string;
    segment: string;
    component: string;
  };
}

const DEFAULT_DELIMITERS = {
  element: "*",
  segment: "~",
  component: ":",
};

/**
 * Tokenize an X12 interchange envelope into typed segments.
 *
 * The first ISA segment is the legal source of the delimiters (the
 * X12 standard requires them to be declared in fixed positions inside
 * ISA itself); if the input does not start with `ISA`, we fall back
 * to the default delimiter set.
 */
export function parseX12(input: string): ParsedX12 {
  // Trim leading whitespace / BOM only — DO NOT strip CRLF before
  // reading the ISA terminator. If a payer's file uses `\n` as the
  // segment terminator (rare but X12-legal), `.replace(/\n+/g, "")`
  // on the unstripped input would drop the terminator byte and the
  // subsequent ISA-offset read would land on data, producing
  // garbage segments. Read the terminator from the original input
  // first, then normalise line endings inside element bodies.
  // Strip leading whitespace and BOM (U+FEFF) using an explicit
  // escape so the eslint no-irregular-whitespace rule doesn't trip
  // on a literal zero-width-no-break-space.
  const trimmed = input.replace(/^[\s\uFEFF]+/, "");
  let delimiters = DEFAULT_DELIMITERS;
  if (trimmed.startsWith("ISA")) {
    // ISA is exactly 106 characters in a 5010-conforming envelope:
    // 105 fixed-width elements + a single-character segment terminator.
    // Element separator is at offset 3 (the char right after `ISA`).
    // ISA16 (component separator) is at offset 104. Segment terminator
    // is at offset 105.
    const elementSep = trimmed[3];
    const componentSep = trimmed[104];
    const segmentSep = trimmed[105];
    if (elementSep && componentSep && segmentSep) {
      delimiters = {
        element: elementSep,
        component: componentSep,
        segment: segmentSep,
      };
    }
  }
  // Now that we've captured the segment terminator, strip CR (always
  // safe — CR is never a legal X12 character outside line endings)
  // and only collapse LF when it's NOT the segment terminator.
  const stripCr = trimmed.replace(/\r/g, "");
  const raw =
    delimiters.segment === "\n" ? stripCr : stripCr.replace(/\n+/g, "");
  const segments: Segment[] = [];
  for (const rawSeg of raw.split(delimiters.segment)) {
    if (!rawSeg) continue;
    const parts = rawSeg.split(delimiters.element);
    const id = parts[0]?.trim();
    if (!id) continue;
    segments.push({ id, elements: parts.slice(1) });
  }
  return { segments, delimiters };
}

/** Split a single composite element into its parts. */
export function splitComposite(value: string, separator: string): string[] {
  if (!value) return [];
  return value.split(separator);
}

/** Cheap money parser — accepts strings like "0", "1.00", "1234.56". */
export function parseMoneyToCents(raw: string | undefined): number {
  if (!raw) return 0;
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  // X12 monetary values are decimal text with at most 2 fractional
  // digits; reject anything else so a malformed value doesn't smuggle
  // a non-numeric or surprise rounding into the ledger.
  if (!/^-?\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error(`Invalid money value: ${raw}`);
  }
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  const [dollars, frac = ""] = body.split(".");
  const cents =
    Number(dollars ?? "0") * 100 + Number((frac + "00").slice(0, 2));
  return negative ? -cents : cents;
}

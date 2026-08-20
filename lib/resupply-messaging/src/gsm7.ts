// @workspace/resupply-messaging — GSM-7 folding for outbound SMS text.
//
// Why this exists
// ---------------
// Twilio encodes a message as GSM-7 (160 characters per segment) only
// while every character is in the GSM 03.38 alphabet. ONE character
// outside it silently switches the WHOLE message to UCS-2, where a
// segment is 70 characters — so a single em-dash turns a one-segment
// reply into a three-segment one, at triple the cost, for every
// recipient.
//
// Static copy is guarded at the source level (see
// `routes/sms/inbound.gsm7.test.ts` and `send-sms.variants.test.ts`).
// Those guards cannot see text composed at RUNTIME, which is where the
// remaining exposure is:
//   - a tenant's configured practice name interpolated into a reply,
//   - an admin-typed office-closure auto-reply,
//   - a reply written by the AI fallback model (a prompt asking for
//     plain ASCII is guidance, not enforcement).
// `toGsm7` is the enforcement point for all three.
//
// Folding, not stripping
// ----------------------
// The GSM-7 alphabet already contains many accented Latin letters
// (a-grave, e-acute, n-tilde, u-umlaut, ...), so a practice named
// "Clinica Munoz" spelled with those letters costs nothing and is kept
// verbatim. Only characters GSM-7 genuinely cannot represent are
// folded: typographic punctuation maps to its ASCII equivalent
// (em-dash to "-", ellipsis to "..."), and other accented letters are
// reduced to their base letter (i-acute to "i") rather than dropped, so
// a brand stays recognisable. Anything with no sensible fallback is
// removed rather than passed through to trigger UCS-2.

/**
 * GSM 03.38 basic character set plus the extension table. Extension
 * characters (^{}\[~]|€) are representable but cost two septets each;
 * they are kept because dropping them would mangle text, and callers
 * that care about exact segment counts use `gsm7Length`.
 */
const GSM7_CHARS = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà" +
    "^{}\\[~]|€",
);

/** Characters that cost two septets in GSM-7 (the extension table). */
const GSM7_EXTENDED = new Set("^{}\\[~]|€");

/**
 * Explicit replacements for the punctuation that actually shows up in
 * copy — typographic dashes, smart quotes, ellipsis, exotic spaces.
 * These are the characters a word processor, a model, or a
 * copy-pasting admin introduces without meaning to.
 */
const FOLD: ReadonlyMap<string, string> = new Map([
  ["—", "-"], // em dash
  ["–", "-"], // en dash
  ["‒", "-"], // figure dash
  ["―", "-"], // horizontal bar
  ["‐", "-"], // hyphen
  ["‑", "-"], // non-breaking hyphen
  ["−", "-"], // minus sign
  ["…", "..."], // ellipsis
  ["“", '"'], // left double quote
  ["”", '"'], // right double quote
  ["„", '"'], // low double quote
  ["«", '"'], // left guillemet
  ["»", '"'], // right guillemet
  ["‘", "'"], // left single quote
  ["’", "'"], // right single quote
  ["‚", "'"], // low single quote
  [" ", " "], // non-breaking space
  [" ", " "], // narrow no-break space
  [" ", " "], // thin space
  ["​", ""], // zero-width space
  ["﻿", ""], // BOM / zero-width no-break space
  ["•", "*"], // bullet
  ["·", "-"], // middle dot
  ["→", "->"], // right arrow
  ["×", "x"], // multiplication sign
  ["™", "(TM)"],
  ["®", "(R)"],
  ["©", "(C)"],
  ["\t", " "],
]);

/**
 * Rewrite `text` so every character is representable in GSM-7, keeping
 * it as close to the original as possible. Safe to call on text that is
 * already GSM-7 — it returns an equal string.
 */
export function toGsm7(text: string): string {
  let out = "";
  for (const ch of text) {
    const folded = FOLD.get(ch);
    if (folded !== undefined) {
      out += folded;
      continue;
    }
    if (GSM7_CHARS.has(ch)) {
      out += ch;
      continue;
    }
    // Not directly representable. Strip diacritics and keep the base
    // letter when that lands in the alphabet ("i-acute" -> "i"), so a
    // name stays readable instead of losing characters outright.
    const base = ch.normalize("NFD").replace(/\p{M}+/gu, "");
    for (const b of base) {
      if (GSM7_CHARS.has(b)) out += b;
    }
  }
  return out;
}

/** True when every character of `text` is representable in GSM-7. */
export function isGsm7(text: string): boolean {
  for (const ch of text) {
    if (!GSM7_CHARS.has(ch)) return false;
  }
  return true;
}

/**
 * Septet cost of `text` under GSM-7 — extension-table characters count
 * twice. Returns null when the text is not GSM-7-representable at all
 * (the caller should fold it first).
 */
export function gsm7Length(text: string): number | null {
  let n = 0;
  for (const ch of text) {
    if (!GSM7_CHARS.has(ch)) return null;
    n += GSM7_EXTENDED.has(ch) ? 2 : 1;
  }
  return n;
}

/**
 * Fold to GSM-7 and clamp to `maxSeptets` (default 160 — one segment),
 * cutting at a word boundary where one is available so the message does
 * not end mid-word. The truncation marker is ASCII "..." rather than a
 * single ellipsis character, which would itself force UCS-2 and defeat
 * the clamp.
 */
export function clampToOneSegment(text: string, maxSeptets = 160): string {
  const folded = toGsm7(text).trim();
  const length = gsm7Length(folded);
  if (length !== null && length <= maxSeptets) return folded;

  const TAIL = "...";
  const budget = maxSeptets - TAIL.length;
  let out = "";
  let used = 0;
  for (const ch of folded) {
    const cost = GSM7_EXTENDED.has(ch) ? 2 : 1;
    if (used + cost > budget) break;
    out += ch;
    used += cost;
  }
  // Prefer a word boundary, but only when one is close enough that we
  // are not throwing away most of the message.
  const lastSpace = out.lastIndexOf(" ");
  if (lastSpace > budget * 0.6) out = out.slice(0, lastSpace);
  return out.trimEnd() + TAIL;
}

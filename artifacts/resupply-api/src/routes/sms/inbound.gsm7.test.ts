// Guard: every string literal in the inbound-SMS route stays plain ASCII.
//
// Why this test exists
// --------------------
// The replies this route returns are TwiML `<Message>` bodies that Twilio
// sends to the patient as a text. Twilio encodes a message as GSM-7 (160
// chars per segment) only while every character is in the GSM-7 alphabet;
// ONE character outside it silently switches the whole message to UCS-2,
// where a segment is 70 characters. A single em-dash therefore turns a
// one-segment reply into a three-segment one, at triple the cost, for
// every patient who gets it.
//
// `lib/resupply-reminders/send-sms.ts` has always documented this for the
// OUTBOUND reminder copy, and `send-sms.variants.test.ts` pins it there.
// The inbound auto-replies had no such guard and had drifted: every
// "Thanks - ..." reply in this route was em-dash-joined and so was billed
// as UCS-2.
//
// Scope: the whole file, not just the reply strings. Distinguishing a
// patient-facing literal from a log message by static analysis is
// brittle, and "ASCII-only string literals in this one file" is a rule
// that is trivially checkable and costs nothing (log lines read fine with
// a comma). Comments are exempt -- they are never sent anywhere, and the
// repo's house style uses em-dashes in prose.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Strip `//` and block comments while leaving string literals intact, so
 * the scan sees exactly the strings the module actually evaluates.
 */
function stripComments(src: string): string {
  const out: string[] = [];
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out.push(c);
      i += 1;
      while (i < src.length) {
        if (src[i] === "\\") {
          out.push(src.slice(i, i + 2));
          i += 2;
          continue;
        }
        out.push(src[i]!);
        const closed = src[i] === c;
        i += 1;
        if (closed) break;
      }
      continue;
    }
    out.push(c!);
    i += 1;
  }
  return out.join("");
}

const STRING_LITERAL =
  /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;

describe("inbound SMS route copy", () => {
  it("uses only GSM-7-safe (ASCII) characters in every string literal", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./inbound.ts", import.meta.url)),
      "utf8",
    );
    const offenders: string[] = [];
    const code = stripComments(src);
    for (const m of code.matchAll(STRING_LITERAL)) {
      const text = m[1] ?? m[2] ?? m[3] ?? "";
      const bad = [
        ...new Set([...text].filter((ch) => ch.charCodeAt(0) > 127)),
      ];
      if (bad.length > 0) {
        const line = code.slice(0, m.index).split("\n").length;
        offenders.push(
          `line ${line}: ${JSON.stringify(bad.join(""))} in ${JSON.stringify(text.slice(0, 80))}`,
        );
      }
    }
    expect(
      offenders,
      `Non-ASCII characters in this route flip Twilio to UCS-2 (70-char segments) ` +
        `for the whole message. Use "-" or a period instead of an em-dash, and a ` +
        `straight quote instead of a curly one:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

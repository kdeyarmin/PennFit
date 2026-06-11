import { describe, expect, it } from "vitest";

import { sectionsToText, textToSections } from "./packet-template-text";

describe("packet-template-text", () => {
  it("round-trips a multi-section document", () => {
    const sections = [
      {
        paragraphs: [
          "Welcome to {{company_name}}. Thank you for trusting us.",
          "Reach us at {{company_phone}} or {{company_email}}.",
        ],
      },
      {
        heading: "Setting up your equipment",
        bullets: [
          "Place the device on a flat surface.",
          "Use distilled water.",
        ],
      },
      {
        heading: "Mixed",
        paragraphs: ["An intro paragraph."],
        bullets: ["A bullet."],
      },
    ];
    expect(textToSections(sectionsToText(sections))).toEqual(sections);
  });

  it("parses headings, bullets, and blank-line paragraph breaks", () => {
    const text = [
      "First paragraph line one",
      "continues on line two.",
      "",
      "Second paragraph.",
      "",
      "---",
      "",
      "# Care",
      "",
      "- Daily: rinse",
      "- Weekly: wash",
    ].join("\n");
    expect(textToSections(text)).toEqual([
      {
        paragraphs: [
          "First paragraph line one continues on line two.",
          "Second paragraph.",
        ],
      },
      { heading: "Care", bullets: ["Daily: rinse", "Weekly: wash"] },
    ]);
  });

  it("ignores empty blocks and preserves merge tokens verbatim", () => {
    const text = "---\n\n# Only\n\nHello {{patient_name}}.\n\n---\n\n   ";
    expect(textToSections(text)).toEqual([
      { heading: "Only", paragraphs: ["Hello {{patient_name}}."] },
    ]);
  });

  it("treats a second # line as paragraph text, not a new heading", () => {
    const text = "# One\n\n# Two";
    expect(textToSections(text)).toEqual([
      { heading: "One", paragraphs: ["# Two"] },
    ]);
  });

  it("returns an empty array for whitespace-only input", () => {
    expect(textToSections("  \n \n")).toEqual([]);
  });
});

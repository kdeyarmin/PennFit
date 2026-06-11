// Plain-text editing format for patient-packet document templates.
//
// The server stores structured sections (headings / paragraphs /
// bullets — never HTML). The admin editor presents them as one
// editable text document and converts back on save:
//
//   # Heading            → starts the section's heading
//   - Bullet item        → a bullet in the current section
//   plain text           → a paragraph (blank line separates paragraphs)
//   ---                  → section divider
//
// {{merge_tokens}} pass through verbatim — the server resolves them.

import type { PacketDocumentSection } from "@workspace/api-client-react/admin";

const DIVIDER = "---";

export function sectionsToText(sections: PacketDocumentSection[]): string {
  return sections
    .map((s) => {
      const lines: string[] = [];
      if (s.heading) lines.push(`# ${s.heading}`);
      for (const p of s.paragraphs ?? []) {
        if (lines.length > 0) lines.push("");
        lines.push(p);
      }
      if (s.bullets && s.bullets.length > 0) {
        if (lines.length > 0) lines.push("");
        for (const b of s.bullets) lines.push(`- ${b}`);
      }
      return lines.join("\n");
    })
    .join(`\n\n${DIVIDER}\n\n`);
}

export function textToSections(text: string): PacketDocumentSection[] {
  const blocks = text
    .split(/(?:^|\n)[ \t]*---+[ \t]*(?:\n|$)/u)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const sections: PacketDocumentSection[] = [];
  for (const block of blocks) {
    let heading: string | undefined;
    const paragraphs: string[] = [];
    const bullets: string[] = [];
    let currentParagraph: string[] = [];

    const flushParagraph = () => {
      if (currentParagraph.length > 0) {
        paragraphs.push(currentParagraph.join(" ").trim());
        currentParagraph = [];
      }
    };

    for (const rawLine of block.split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0) {
        flushParagraph();
        continue;
      }
      if (line.startsWith("# ") && heading === undefined) {
        flushParagraph();
        heading = line.slice(2).trim();
        continue;
      }
      if (line.startsWith("- ")) {
        flushParagraph();
        const item = line.slice(2).trim();
        if (item) bullets.push(item);
        continue;
      }
      currentParagraph.push(line);
    }
    flushParagraph();

    if (heading || paragraphs.length > 0 || bullets.length > 0) {
      sections.push({
        ...(heading ? { heading } : {}),
        ...(paragraphs.length > 0 ? { paragraphs } : {}),
        ...(bullets.length > 0 ? { bullets } : {}),
      });
    }
  }
  return sections;
}

// Drift guard: the in-app assistant's guide index must match the Help Center.
//
// The assistant (PennPilot) and the Help Center answer the same question —
// "how do I do X" — from two different places. Once the assistant carries a
// list of guide slugs so it can hand over to the written procedure, that
// list is a second copy of the index, and copies rot:
//
//   * a guide gets renamed → the assistant links operators to a 404,
//   * a guide gets added   → the assistant never mentions it and keeps
//                            improvising the procedure it was meant to
//                            hand over, which is exactly the drift the
//                            hand-over was introduced to prevent.
//
// So this checks BOTH directions, unlike the nav/app-map guard: the two
// lists must be equal, not merely overlapping. Titles are compared too, so
// retitling a guide forces the index to follow.
//
// allow-source-read: the knowledge base is a module-level template literal
// in a SIBLING PACKAGE (resupply-api) that this SPA package must not import
// at runtime — it is a server-side LLM prompt, not served over any
// endpoint. Reading the literal is the only way to compare the two, exactly
// as AppShell.assistant-app-map.test.ts does for the nav.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { HOW_TO_GUIDES } from "./how-tos";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KNOWLEDGE_PATH = path.resolve(
  __dirname,
  "../../../../resupply-api/src/lib/admin-assistant/adminAssistantKnowledge.ts",
);
const KNOWLEDGE_SRC = readFileSync(KNOWLEDGE_PATH, "utf8");

/** The HELP_CENTER_SECTION template literal, unwrapped. */
function helpCenterSection(): string {
  const marker = "const HELP_CENTER_SECTION = `";
  const start = KNOWLEDGE_SRC.indexOf(marker);
  if (start < 0) {
    throw new Error(
      "HELP_CENTER_SECTION literal not found in adminAssistantKnowledge.ts — " +
        "the assistant no longer carries the Help Center index, so operators " +
        "will get improvised procedures instead of the written guides.",
    );
  }
  const from = start + marker.length;
  const end = KNOWLEDGE_SRC.indexOf("`;", from);
  if (end < 0) throw new Error("unterminated HELP_CENTER_SECTION literal");
  return KNOWLEDGE_SRC.slice(from, end);
}

/** `slug — Title` rows out of the section's indented guide list. */
function indexedGuides(): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of helpCenterSection().split("\n")) {
    const m = /^\s{4}([a-z0-9-]+) — (.+?)\s*$/.exec(line);
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

describe("assistant ↔ Help Center guide index", () => {
  it("carries the section at all, and wires it into the prompt", () => {
    expect(helpCenterSection().length).toBeGreaterThan(0);
    // Present in the file is not enough — it has to be assembled in.
    expect(KNOWLEDGE_SRC).toContain("HELP_CENTER_SECTION,");
  });

  it("lists every published how-to", () => {
    const indexed = indexedGuides();
    const missing = HOW_TO_GUIDES.filter((g) => !indexed.has(g.slug)).map(
      (g) => g.slug,
    );
    expect(
      missing,
      `These how-tos exist but the assistant's index does not list them, so ` +
        `it will improvise the procedure instead of linking the guide: ` +
        missing.join(", "),
    ).toEqual([]);
  });

  it("lists no how-to that does not exist", () => {
    const slugs = new Set(HOW_TO_GUIDES.map((g) => g.slug));
    const stale = [...indexedGuides().keys()].filter((s) => !slugs.has(s));
    expect(
      stale,
      `The assistant's index names these slugs, but no such guide exists — ` +
        `it would send operators to a 404: ` +
        stale.join(", "),
    ).toEqual([]);
  });

  it("uses each guide's current title", () => {
    const indexed = indexedGuides();
    const wrong = HOW_TO_GUIDES.filter(
      (g) => indexed.has(g.slug) && indexed.get(g.slug) !== g.title,
    ).map(
      (g) =>
        `${g.slug}: index says "${indexed.get(g.slug)}", guide says "${g.title}"`,
    );
    expect(wrong, wrong.join(" | ")).toEqual([]);
  });

  it("states the right guide count", () => {
    const stated = /Guides \((\d+)\):/.exec(helpCenterSection())?.[1];
    expect(Number(stated)).toBe(HOW_TO_GUIDES.length);
  });

  it("tells the assistant the route shape and to hand over rather than retype", () => {
    const section = helpCenterSection();
    expect(section).toContain("/admin/resources/how-to/<slug>");
    expect(section).toContain("/admin/resources/user-guide");
    expect(section).toContain("/admin/resources/faq");
    // The behavioral instruction is the entire point of the section.
    expect(section.toLowerCase()).toContain("do not retype");
  });

  it("leaves headroom under the system-prompt cap", () => {
    // adminAssistantKnowledge throws above 40_000 chars at request time.
    // Failing here instead means a growing help index is caught in CI
    // rather than by every admin chat request 503-ing in production.
    const cap = /MAX_ADMIN_SYSTEM_PROMPT_CHARS = (\d[\d_]*)/.exec(
      KNOWLEDGE_SRC,
    )?.[1];
    expect(cap, "prompt cap constant not found").toBeTruthy();
    const capValue = Number(cap!.replace(/_/g, ""));
    const literals = [...KNOWLEDGE_SRC.matchAll(/`([\s\S]*?)`/g)].reduce(
      (sum, m) => sum + m[1]!.length,
      0,
    );
    expect(
      literals,
      `The knowledge base's template literals total ${literals} chars against ` +
        `a ${capValue} cap. Trim a section before adding more.`,
    ).toBeLessThan(capValue * 0.9);
  });
});

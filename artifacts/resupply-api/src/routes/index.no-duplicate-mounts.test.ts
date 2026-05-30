// Static guard against duplicate router mounts in routes/index.ts.
//
// History: in May 2026 a refactor accidentally registered ten admin
// routers twice (shopReturnsAdminRouter, csrMacrosRouter, …). The
// effect was double middleware execution per request — duplicate
// audit rows, duplicate side effects on retry. The duplicates were
// removed; this test makes sure no future merge re-introduces the
// shape.
//
// Approach: parse the source of routes/index.ts, count
// `router.use(<name>);` occurrences for each imported router-shaped
// identifier, and fail if any is mounted more than once. We
// deliberately keep this static (no app boot, no Express
// instantiation) so the check runs in milliseconds and catches a
// regression at the same place a code reviewer would.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_INDEX = readFileSync(path.join(__dirname, "index.ts"), "utf8");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("routes/index.ts router mounts", () => {
  const code = stripComments(ROUTES_INDEX);

  it("mounts each router exactly once", () => {
    const counts = new Map<string, number>();
    // Match `router.use(<identifier>);` only — skip prefixed mounts
    // like `router.use("/admin", ...)` because those are middleware
    // attachments, not router mounts.
    const re = /router\.use\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;
    for (const m of code.matchAll(re)) {
      const name = m[1]!;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const duplicates = Array.from(counts.entries()).filter(
      ([, count]) => count > 1,
    );
    expect(
      duplicates,
      `Each router in routes/index.ts must be mounted exactly once. ` +
        `Duplicates: ${JSON.stringify(duplicates)}`,
    ).toEqual([]);
  });

  it("imports each router-shaped identifier exactly once", () => {
    const importedNames = new Map<string, number>();
    const re = /^import\s+([A-Za-z_][A-Za-z0-9_]*)\s+from/gm;
    for (const m of code.matchAll(re)) {
      const name = m[1]!;
      importedNames.set(name, (importedNames.get(name) ?? 0) + 1);
    }
    const duplicateImports = Array.from(importedNames.entries()).filter(
      ([, count]) => count > 1,
    );
    expect(duplicateImports).toEqual([]);
  });
});

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

  // The two checks above catch the SAME router mounted twice, but not two
  // DIFFERENT routers claiming the same method+path — Express first-match-
  // wins, so the later mount is permanently shadowed dead code. That shape
  // shipped in June 2026: admin/resupply-funnel.ts registered
  // `GET /admin/analytics/resupply-funnel`, already claimed by
  // admin/analytics.ts mounted ~100 lines earlier, so its handler (with a
  // different query contract) could never execute. Scan every route file
  // bare-mounted from routes/index.ts — they all share the /resupply-api
  // namespace and carry their own absolute paths — and fail on any
  // method+path registered twice. Param NAMES are normalized (`:id` ⇄
  // `:patientId`) because Express matches params by position, so two
  // routes differing only in param name still collide.
  it("registers each method+path at most once across bare-mounted routers", () => {
    const importPathByName = new Map<string, string>();
    const importRe =
      /^import\s+([A-Za-z_][A-Za-z0-9_]*)\s+from\s+"(\.\/[^"]+)\.js"/gm;
    for (const m of code.matchAll(importRe)) {
      importPathByName.set(m[1]!, m[2]!);
    }

    const bareMounted = new Set<string>();
    const mountRe = /router\.use\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;
    for (const m of code.matchAll(mountRe)) bareMounted.add(m[1]!);

    const registrations = new Map<string, string[]>();
    const regRe =
      /\brouter\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*\n?\s*"([^"]+)"/g;
    for (const name of bareMounted) {
      const rel = importPathByName.get(name);
      if (!rel) continue;
      let src: string;
      try {
        src = readFileSync(path.join(__dirname, `${rel}.ts`), "utf8");
      } catch {
        continue; // compiled-only import — typecheck owns missing files
      }
      const body = stripComments(src);
      for (const m of body.matchAll(regRe)) {
        const normalizedPath = m[2]!.replace(/:[A-Za-z0-9_]+/g, ":p");
        const key = `${m[1]!.toUpperCase()} ${normalizedPath}`;
        const locs = registrations.get(key) ?? [];
        locs.push(`${rel}.ts (${m[2]!})`);
        registrations.set(key, locs);
      }
    }

    // Sanity floor: the flat tree is ~260 routers / ~800 paths. If the
    // scan ever collapses (regex drift, import-shape change), fail loudly
    // instead of green-lighting an empty scan.
    expect(registrations.size).toBeGreaterThan(500);

    const duplicates = Array.from(registrations.entries()).filter(
      ([, locs]) => locs.length > 1,
    );
    expect(
      duplicates,
      `Each method+path may be registered by exactly one bare-mounted ` +
        `router — Express first-match-wins silently shadows the rest. ` +
        `Duplicates: ${JSON.stringify(duplicates, null, 2)}`,
    ).toEqual([]);
  });
});

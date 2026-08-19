// Drift guard: every feature flag must be BOTH in the FEATURE_FLAG_KEYS
// allow-list AND seeded into resupply.feature_flags by a migration.
//
// Why both halves matter for the admin settings page (Control Center):
//   * A key in FEATURE_FLAG_KEYS but NOT seeded never appears in the
//     Control Center (the list reads seeded rows) and PATCH rejects it
//     with `flag_not_seeded` — so an operator can't toggle it. Worse,
//     isFeatureEnabled() treats an unseeded key as ENABLED, silently
//     flipping an intended-off feature on.
//   * A seeded key NOT in FEATURE_FLAG_KEYS shows in the list but PATCH
//     rejects it as `unknown_flag` — the toggle is dead.
//
// Keeping the two sets identical guarantees "every feature that can be
// turned on/off is in the settings page, and is actually toggleable".

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, it, expect } from "vitest";

import { FEATURE_FLAG_KEYS } from "./feature-flags";

const here = dirname(fileURLToPath(import.meta.url));
// artifacts/resupply-api/src/lib -> repo root -> lib/resupply-db/migrations
const MIGRATIONS_DIR = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "lib",
  "resupply-db",
  "migrations",
);

/**
 * Keys seeded by any migration's `INSERT INTO resupply.feature_flags`,
 * minus keys a LATER migration retires with a
 * `DELETE FROM resupply.feature_flags WHERE key = '...'` (e.g. 0503
 * retiring inbound_referrals.dispatcher after its subsystem was removed).
 * Files are replayed in numeric-prefix order — the same order the
 * migrator applies them — so a retire-then-reseed sequence resolves the
 * way a real database would.
 */
function seededFlagKeys(): Set<string> {
  const keys = new Set<string>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    if (!sql.includes("feature_flags")) continue;
    // A feature-flag VALUES tuple is uniquely shaped: ('key', true|false,
    // ...). The enabled boolean immediately follows the key (possibly
    // across a newline), which no other table's seed tuple matches.
    const insertRe = /\(\s*'([a-z0-9_.]+)'\s*,\s*(?:true|false)\b/g;
    const deleteRe =
      /DELETE FROM "?resupply"?\."?feature_flags"?\s+WHERE\s+"?key"?\s*=\s*'([a-z0-9_.]+)'/g;
    const ops: Array<{ index: number; key: string; kind: "add" | "del" }> = [];
    let m: RegExpExecArray | null;
    while ((m = insertRe.exec(sql)) !== null) {
      ops.push({ index: m.index, key: m[1]!, kind: "add" });
    }
    while ((m = deleteRe.exec(sql)) !== null) {
      ops.push({ index: m.index, key: m[1]!, kind: "del" });
    }
    ops.sort((a, b) => a.index - b.index);
    for (const op of ops) {
      if (op.kind === "add") keys.add(op.key);
      else keys.delete(op.key);
    }
  }
  return keys;
}

describe("feature flag catalog ↔ seed migrations", () => {
  const seeded = seededFlagKeys();
  const codeKeys = new Set<string>(FEATURE_FLAG_KEYS);

  it("found a non-trivial set of seeded flags (sanity)", () => {
    expect(seeded.size).toBeGreaterThan(10);
  });

  it("every FEATURE_FLAG_KEYS entry is seeded (so it shows + toggles in settings)", () => {
    const missing = [...codeKeys].filter((k) => !seeded.has(k)).sort();
    expect(
      missing,
      `not seeded in any migration: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every seeded flag is in FEATURE_FLAG_KEYS (so PATCH accepts the toggle)", () => {
    const extra = [...seeded].filter((k) => !codeKeys.has(k)).sort();
    expect(
      extra,
      `seeded but not in FEATURE_FLAG_KEYS: ${extra.join(", ")}`,
    ).toEqual([]);
  });
});

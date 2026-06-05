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
// artifacts/resupply-api/src/lib -> repo root -> lib/resupply-db/drizzle
const DRIZZLE_DIR = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "lib",
  "resupply-db",
  "drizzle",
);

/** Keys seeded by any migration's `INSERT INTO resupply.feature_flags`. */
function seededFlagKeys(): Set<string> {
  const keys = new Set<string>();
  const files = readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith(".sql"));
  for (const file of files) {
    const sql = readFileSync(join(DRIZZLE_DIR, file), "utf8");
    if (!sql.includes("resupply.feature_flags")) continue;
    // A feature-flag VALUES tuple is uniquely shaped: ('key', true|false,
    // ...). The enabled boolean immediately follows the key (possibly
    // across a newline), which no other table's seed tuple matches.
    const re = /\(\s*'([a-z0-9_.]+)'\s*,\s*(?:true|false)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) keys.add(m[1]!);
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

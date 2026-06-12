// Regression tests for the RUN_DB_MIGRATIONS gate (app-review
// 2026-06-10, P2-16): the historical exact-string `=== "true"` check
// meant `TRUE` / `1` silently skipped migrations while the deploy
// proceeded — the schema-drift incident class in the repo's
// post-mortem. The classifier must accept common truthy spellings,
// skip on explicit falsy spellings, and flag everything else as
// invalid so deploy-migrate.mjs can fail the deploy loudly.

import { describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs module without type declarations.
import { classifyRunDbMigrations } from "./run-db-migrations-gate.mjs";

describe("classifyRunDbMigrations", () => {
  it.each(["true", "TRUE", "True", " true ", "1", "yes", "YES", "on"])(
    "classifies %j as run",
    (raw) => {
      expect(classifyRunDbMigrations(raw)).toBe("run");
    },
  );

  it.each([undefined, "", "  ", "false", "FALSE", "0", "no", "off"])(
    "classifies %j as skip",
    (raw) => {
      expect(classifyRunDbMigrations(raw)).toBe("skip");
    },
  );

  it.each(["truee", "ture", "enable", "2", "yes please"])(
    "classifies the typo %j as invalid (deploy must fail loudly)",
    (raw) => {
      expect(classifyRunDbMigrations(raw)).toBe("invalid");
    },
  );
});

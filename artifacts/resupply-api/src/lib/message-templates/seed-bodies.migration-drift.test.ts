// Drift guard: the CURRENT seeding migration's template rows must embed
// the seed-bodies.ts constants verbatim.
//
// That migration is 0513, not the original 0502: the seeded bodies were
// re-pointed at the shared branded email layout, and 0502 is immutable
// (M1), so 0513 re-states all five rows as the corrective upsert. 0513 is
// therefore what a database ends up holding, and what this guard compares
// the seed module against.
//
// Why: the parity suite (seed-bodies.parity.test.ts) proves the TS
// constants render byte-identically to the fallback renderers — but what
// production databases actually receive is the .sql. If either side is
// edited without the other, the parity guarantee silently detaches from
// the shipped rows. This test pins the pairing: every subject/body and
// the allowed-variables list must appear in the migration exactly as the
// module exports them (dollar-quoted, so no escaping transforms apply).
//
// allow-source-read: this is a structural drift check between two static
// artifacts (the TS seed constants and the hand-shipped migration file).
// There is no behavioral equivalent — the migration's content is not
// reachable at runtime, and replaying it against a live database in a
// unit test would be slower and flakier than reading the file.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MESSAGE_TEMPLATE_SEEDS } from "./seed-bodies";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  path.join(
    __dirname,
    "../../../../../lib/resupply-db/migrations/0513_rebrand_message_template_rows.sql",
  ),
  "utf8",
);

describe("migration 0513 ⇄ seed-bodies.ts", () => {
  it("covers every seed exactly once", () => {
    for (const seed of MESSAGE_TEMPLATE_SEEDS) {
      const marker = `'${seed.templateKey}',\n  '${seed.channel}',`;
      const first = MIGRATION.indexOf(marker);
      expect(
        first,
        `${seed.templateKey}/${seed.channel} missing`,
      ).toBeGreaterThan(-1);
      expect(
        MIGRATION.indexOf(marker, first + 1),
        `${seed.templateKey}/${seed.channel} seeded twice`,
      ).toBe(-1);
    }
  });

  it("embeds each subject/body verbatim (dollar-quoted)", () => {
    for (const seed of MESSAGE_TEMPLATE_SEEDS) {
      const label = `${seed.templateKey}/${seed.channel}`;
      expect(MIGRATION, `${label} bodyText drifted`).toContain(
        `$tpl$${seed.bodyText}$tpl$`,
      );
      if (seed.subject !== null) {
        expect(MIGRATION, `${label} subject drifted`).toContain(
          `$tpl$${seed.subject}$tpl$`,
        );
      }
      if (seed.bodyHtml !== null) {
        expect(MIGRATION, `${label} bodyHtml drifted`).toContain(
          `$tpl$${seed.bodyHtml}$tpl$`,
        );
      }
    }
  });

  it("embeds each allowed-variables list verbatim", () => {
    for (const seed of MESSAGE_TEMPLATE_SEEDS) {
      expect(
        MIGRATION,
        `${seed.templateKey}/${seed.channel} allowed_variables drifted`,
      ).toContain(`'${JSON.stringify(seed.allowedVariables)}'::jsonb`);
    }
  });

  it("stays idempotent and seed-org-scoped", () => {
    const inserts = MIGRATION.match(
      /INSERT INTO "resupply"\."message_templates"/g,
    );
    expect(inserts?.length).toBe(MESSAGE_TEMPLATE_SEEDS.length);
    expect(
      MIGRATION.match(
        /ON CONFLICT \("template_key", "channel"\) DO UPDATE SET/g,
      )?.length,
    ).toBe(MESSAGE_TEMPLATE_SEEDS.length);
    // The upsert must never clobber copy an operator has hand-edited.
    expect(
      MIGRATION.match(/WHERE "message_templates"\."updated_by" IS NULL;/g)
        ?.length,
    ).toBe(MESSAGE_TEMPLATE_SEEDS.length);
    expect(
      MIGRATION.match(/WHERE o\."slug" = 'penn-home-medical'/g)?.length,
    ).toBe(MESSAGE_TEMPLATE_SEEDS.length);
  });
});

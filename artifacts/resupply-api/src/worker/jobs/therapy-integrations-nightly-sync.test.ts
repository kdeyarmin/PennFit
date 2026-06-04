// Regression guard (structural source check): the nightly therapy-sync
// scan MUST keyset-bound and rotate by staleness. The previous unpaginated
// read truncated at PostgREST's ~1000-row cap in an arbitrary order, so the
// same ~1000 active links were synced every night and the rest never were.
// Ordering by last_synced_at (nulls first) rotates coverage across nights;
// the per-run limit keeps the throttled fetch loop within the job lease. A
// behavioural test would need a paged Supabase mock plus adapter stubs;
// pin the invariants cheaply, like the dedup / IDOR source checks elsewhere
// in this tree.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "therapy-integrations-nightly-sync.ts",
  ),
  "utf8",
);

describe("therapy nightly-sync — bounded, rotating scan", () => {
  it("does not use a raw high .limit() that PostgREST would silently cap", () => {
    expect(SRC).not.toContain(".limit(5000)");
  });

  it("rotates by least-recently-synced (last_synced_at, nulls first)", () => {
    expect(SRC).toContain(
      '.order("last_synced_at", { ascending: true, nullsFirst: true })',
    );
  });

  it("bounds the scan to one page per run", () => {
    expect(SRC).toContain(".limit(MAX_LINKS_PER_RUN)");
  });
});

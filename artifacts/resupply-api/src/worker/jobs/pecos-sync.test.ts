// Regression guard (structural source check): collectActiveNpis MUST
// keyset-paginate the providers read. The previous unpaginated read
// truncated at PostgREST's ~1000-row cap, so at the documented <2K provider
// population roughly half were never PECOS-checked. It must also surface a
// query error (instead of silently syncing nothing) and bound the
// distinct-NPI set so the throttled per-NPI loop stays within the job
// lease. A behavioural test would need a paged Supabase mock; pin the
// invariants cheaply, like the dedup / IDOR source checks elsewhere in this
// tree.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "pecos-sync.ts"),
  "utf8",
);

describe("pecos-sync — paginated, bounded NPI collection", () => {
  it("does not use a raw high .limit() that PostgREST would silently cap", () => {
    expect(SRC).not.toContain(".limit(5000)");
  });

  it("keyset-pages the providers read (range + id order)", () => {
    expect(SRC).toContain('.order("id", { ascending: true })');
    expect(SRC).toContain(".range(from, from + PAGE_SIZE - 1)");
  });

  it("surfaces a providers query error instead of silently syncing nothing", () => {
    expect(SRC).toContain("if (error) throw error;");
  });

  it("bounds the distinct-NPI set per run", () => {
    expect(SRC).toContain("MAX_NPIS_PER_RUN");
  });
});

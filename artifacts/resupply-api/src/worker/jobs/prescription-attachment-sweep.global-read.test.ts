// Multi-tenant correctness for the attachment sweep's reference loaders.
//
// The storage bucket is shared across ALL tenants, so an attachment is an
// orphan only if NO tenant references it. buildProductionSweepDeps()'s
// loadReferencedKeys / isStillReferenced must therefore read references
// GLOBALLY (no org_id filter) — a seed-org-scoped read would treat
// another tenant's attachment as an orphan and delete its PHI.

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseFilterCalls,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { buildProductionSweepDeps } from "./prescription-attachment-sweep.js";

beforeEach(() => supabaseMock.reset());

describe("buildProductionSweepDeps — global (cross-tenant) reference reads", () => {
  it("loadReferencedKeys unions both writers' keys WITHOUT an org_id filter", async () => {
    // One page each (under the 1000 cap) so the pagination loop exits.
    stageSupabaseResponse("prescriptions", "select", {
      data: [{ id: "p1", attachment_object_key: "attachments/a.pdf" }],
    });
    stageSupabaseResponse("message_attachments", "select", {
      data: [{ id: "m1", object_key: "attachments/b.png" }],
    });

    const deps = buildProductionSweepDeps(new Date(), 0);
    const keys = await deps.loadReferencedKeys();

    expect(keys.has("attachments/a.pdf")).toBe(true);
    expect(keys.has("attachments/b.png")).toBe(true);

    // The read must be GLOBAL: no .eq("org_id", …) on either table.
    const presFilters = getSupabaseFilterCalls("prescriptions", "select");
    const msgFilters = getSupabaseFilterCalls("message_attachments", "select");
    const hasOrgFilter = (
      calls: { verb: string; args: unknown[] }[],
    ): boolean => calls.some((c) => c.verb === "eq" && c.args[0] === "org_id");
    expect(hasOrgFilter(presFilters)).toBe(false);
    expect(hasOrgFilter(msgFilters)).toBe(false);
  });

  it("isStillReferenced counts across all tenants (no org_id filter); any hit blocks the delete", async () => {
    // A prescription in some tenant still references the key.
    stageSupabaseResponse("prescriptions", "select", { count: 1, data: null });
    stageSupabaseResponse("message_attachments", "select", {
      count: 0,
      data: null,
    });

    const deps = buildProductionSweepDeps(new Date(), 0);
    const still = await deps.isStillReferenced("attachments/a.pdf");

    expect(still).toBe(true);
    const presFilters = getSupabaseFilterCalls("prescriptions", "select");
    expect(
      presFilters.some((c) => c.verb === "eq" && c.args[0] === "org_id"),
    ).toBe(false);
  });
});

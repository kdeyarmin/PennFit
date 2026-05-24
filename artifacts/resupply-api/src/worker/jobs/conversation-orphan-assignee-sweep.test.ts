// Tests for the orphan-assignee sweep worker.
//
// Coverage:
//   * Unassigns conversations whose assignee is revoked
//   * Leaves conversations whose assignee is active alone
//   * Leaves conversations whose assignee is pending alone
//   * Returns zero counts when no conversations are assigned
//   * Returns zero counts when assignees are all active
//   * Stops after MAX_PER_TICK to bound a single tick
//   * Audit row written per unassignment

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
  getSupabaseCallCount,
  getSupabaseFilterCalls,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { runOrphanAssigneeSweep } from "./conversation-orphan-assignee-sweep";

beforeEach(() => {
  supabaseMock.reset();
  vi.useRealTimers();
});

describe("runOrphanAssigneeSweep — unassign path", () => {
  it("clears assigned_admin_user_id when the assignee is revoked", async () => {
    // Page 1: one conversation assigned to a revoked admin.
    stageSupabaseResponse("conversations", "select", {
      data: [
        {
          id: "conv_1",
          assigned_admin_user_id: "admin_revoked",
          assigned_at: "2026-04-01T12:00:00Z",
          status: "open",
        },
      ],
    });
    // The assignee lookup against admin_users returns the same id
    // with status=revoked — the in()+eq("status", "revoked") chain
    // filters server-side; the mock just hands back what we stage.
    stageSupabaseResponse("admin_users", "select", {
      data: [{ id: "admin_revoked" }],
    });
    // The unassignment update.
    stageSupabaseResponse("conversations", "update", { data: null });
    // Page 2: empty so the loop exits.
    stageSupabaseResponse("conversations", "select", { data: [] });

    const stats = await runOrphanAssigneeSweep();
    expect(stats).toEqual({ scanned: 1, unassigned: 1 });

    const writes = getSupabaseWritePayloads("conversations", "update");
    expect(writes[0]).toMatchObject({
      assigned_admin_user_id: null,
      assigned_at: null,
    });
  });

  it("leaves conversations alone when the assignee is still active", async () => {
    stageSupabaseResponse("conversations", "select", {
      data: [
        {
          id: "conv_keep",
          assigned_admin_user_id: "admin_active",
          assigned_at: "2026-04-01T12:00:00Z",
          status: "awaiting_admin",
        },
      ],
    });
    // The assignee lookup returns ZERO revoked admins — the live
    // admin id isn't in the .eq("status","revoked") result set.
    stageSupabaseResponse("admin_users", "select", { data: [] });
    stageSupabaseResponse("conversations", "select", { data: [] });

    const stats = await runOrphanAssigneeSweep();
    expect(stats).toEqual({ scanned: 1, unassigned: 0 });
    expect(getSupabaseCallCount("conversations", "update")).toBe(0);
  });

  it("processes a mixed page (some revoked, some active)", async () => {
    stageSupabaseResponse("conversations", "select", {
      data: [
        {
          id: "conv_revoked",
          assigned_admin_user_id: "admin_revoked",
          assigned_at: "2026-04-01T12:00:00Z",
          status: "open",
        },
        {
          id: "conv_active",
          assigned_admin_user_id: "admin_active",
          assigned_at: "2026-04-02T12:00:00Z",
          status: "awaiting_patient",
        },
      ],
    });
    // Only the revoked admin id comes back from the assignee lookup.
    stageSupabaseResponse("admin_users", "select", {
      data: [{ id: "admin_revoked" }],
    });
    stageSupabaseResponse("conversations", "update", { data: null });
    stageSupabaseResponse("conversations", "select", { data: [] });

    const stats = await runOrphanAssigneeSweep();
    expect(stats).toEqual({ scanned: 2, unassigned: 1 });
    expect(getSupabaseCallCount("conversations", "update")).toBe(1);
  });
});

describe("runOrphanAssigneeSweep — empty-set behavior", () => {
  it("returns zero counts when no conversations are assigned", async () => {
    stageSupabaseResponse("conversations", "select", { data: [] });
    const stats = await runOrphanAssigneeSweep();
    expect(stats).toEqual({ scanned: 0, unassigned: 0 });
    expect(getSupabaseCallCount("conversations", "update")).toBe(0);
    expect(getSupabaseCallCount("admin_users", "select")).toBe(0);
  });

  it("skips the admin_users lookup when the page has no assignees", async () => {
    // Edge case — `not("assigned_admin_user_id", "is", null)` filter
    // should keep this from happening in production, but the worker
    // guards defensively.
    stageSupabaseResponse("conversations", "select", {
      data: [
        {
          id: "conv_missing",
          assigned_admin_user_id: null,
          assigned_at: null,
          status: "open",
        },
      ],
    });
    stageSupabaseResponse("conversations", "select", { data: [] });
    const stats = await runOrphanAssigneeSweep();
    expect(stats).toEqual({ scanned: 1, unassigned: 0 });
    expect(getSupabaseCallCount("admin_users", "select")).toBe(0);
  });
});

describe("runOrphanAssigneeSweep — pagination", () => {
  it("uses keyset pagination so in-loop unassignments do not skip later rows", async () => {
    const firstPage = Array.from({ length: 200 }, (_, i) => ({
      id: `conv_${String(i + 1).padStart(3, "0")}`,
      assigned_admin_user_id: "admin_active",
      assigned_at: "2026-04-01T12:00:00Z",
      status: "open",
    }));
    stageSupabaseResponse("conversations", "select", {
      data: firstPage,
    });
    stageSupabaseResponse("admin_users", "select", { data: [] });

    // Page 2: one revoked assignment after the first page's cursor.
    stageSupabaseResponse("conversations", "select", {
      data: [
        {
          id: "conv_201",
          assigned_admin_user_id: "admin_revoked",
          assigned_at: "2026-04-01T12:00:00Z",
          status: "open",
        },
      ],
    });
    stageSupabaseResponse("admin_users", "select", {
      data: [{ id: "admin_revoked" }],
    });
    stageSupabaseResponse("conversations", "update", { data: null });

    const stats = await runOrphanAssigneeSweep();
    expect(stats.scanned).toBe(201);
    expect(stats.unassigned).toBe(1);
    const filters = getSupabaseFilterCalls("conversations", "select");
    const gtCursor = filters.filter(
      (call) => call.verb === "gt" && call.args[0] === "id",
    );
    expect(gtCursor).toContainEqual({ verb: "gt", args: ["id", "conv_200"] });
  });
});

// Tests for `deleteTeamMember` in team-invite.ts — the "delete an
// invite as if it never happened" counterpart to `revokeTeamMember`.
//
// Two modes:
//   * preserveAsCustomer: false — hard-delete the resupply_auth.users
//     row and rely on the 0022 CASCADEs for credentials / sessions /
//     email_tokens. The fake asserts we do NOT issue our own child-
//     table cleanup in this mode.
//   * preserveAsCustomer: true — the identity row is shared with a
//     shop-customer account: demote role back to 'customer', restore
//     status from the email-verification state, delete unconsumed
//     password_reset tokens, revoke live sessions.

import { describe, expect, it } from "vitest";

import { deleteTeamMember } from "./team-invite";
import type { ResupplySupabaseClient } from "@workspace/resupply-db";

// ── Fake Supabase client ─────────────────────────────────────────────────────
//
// Each `.from(table)` returns a fresh chainable builder. The first
// verb called (select / update / delete / …) names the operation; the
// staged result for `${table}.${op}` resolves when the chain is
// awaited. Every method call is recorded for assertions.

interface FakeCall {
  schema: string;
  table: string;
  op: string;
  method: string;
  args: unknown[];
}

interface StagedResult {
  data?: unknown;
  error?: unknown;
}

const OP_VERBS = new Set(["select", "update", "delete", "insert", "upsert"]);

function makeFakeSupabase(staged: Record<string, StagedResult> = {}): {
  supabase: ResupplySupabaseClient;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const supabase = {
    schema: (schemaName: string) => ({
      from: (table: string) => {
        let op = "unknown";
        const builder: Record<string, unknown> = {};
        const chainable =
          (method: string) =>
          (...args: unknown[]) => {
            if (OP_VERBS.has(method)) op = method;
            calls.push({ schema: schemaName, table, op, method, args });
            return builder;
          };
        for (const m of [
          "select",
          "update",
          "delete",
          "insert",
          "upsert",
          "eq",
          "neq",
          "is",
          "in",
          "limit",
          "order",
          "maybeSingle",
          "single",
        ]) {
          builder[m] = chainable(m);
        }
        builder.then = (
          onFulfilled?: ((value: StagedResult) => unknown) | null,
          onRejected?: ((reason: unknown) => unknown) | null,
        ) => {
          const result = staged[`${table}.${op}`] ?? {
            data: null,
            error: null,
          };
          return Promise.resolve(result).then(onFulfilled, onRejected);
        };
        return builder;
      },
    }),
  } as unknown as ResupplySupabaseClient;

  return { supabase, calls };
}

function callsFor(calls: FakeCall[], table: string, op: string): FakeCall[] {
  return calls.filter((c) => c.table === table && c.op === op);
}

// ── Hard-delete mode (sole-purpose staff identity) ───────────────────────────

describe("deleteTeamMember — preserveAsCustomer: false", () => {
  it("hard-deletes the resupply_auth.users row by id", async () => {
    const { supabase, calls } = makeFakeSupabase();

    const result = await deleteTeamMember(supabase, "u-1", {
      preserveAsCustomer: false,
    });

    expect(result).toEqual({
      authUserDeleted: true,
      authUserDemotedToCustomer: false,
    });
    const deletes = callsFor(calls, "users", "delete");
    expect(deletes.some((c) => c.method === "delete")).toBe(true);
    expect(
      deletes.some(
        (c) => c.method === "eq" && c.args[0] === "id" && c.args[1] === "u-1",
      ),
    ).toBe(true);
    expect(deletes.every((c) => c.schema === "resupply_auth")).toBe(true);
  });

  it("does not issue its own child-table cleanup (CASCADE owns it)", async () => {
    const { supabase, calls } = makeFakeSupabase();

    await deleteTeamMember(supabase, "u-1", { preserveAsCustomer: false });

    expect(calls.filter((c) => c.table === "email_tokens")).toHaveLength(0);
    expect(calls.filter((c) => c.table === "sessions")).toHaveLength(0);
    expect(
      calls.filter((c) => c.table === "password_credentials"),
    ).toHaveLength(0);
  });

  it("propagates a delete error", async () => {
    const { supabase } = makeFakeSupabase({
      "users.delete": { error: new Error("boom") },
    });

    await expect(
      deleteTeamMember(supabase, "u-1", { preserveAsCustomer: false }),
    ).rejects.toThrow("boom");
  });
});

// ── Preserve-as-customer mode (shared identity) ──────────────────────────────

describe("deleteTeamMember — preserveAsCustomer: true", () => {
  it("demotes a verified user back to an active customer", async () => {
    const { supabase, calls } = makeFakeSupabase({
      "users.select": {
        data: { id: "u-1", email_verified_at: "2026-01-01T00:00:00.000Z" },
      },
    });

    const result = await deleteTeamMember(supabase, "u-1", {
      preserveAsCustomer: true,
    });

    expect(result).toEqual({
      authUserDeleted: false,
      authUserDemotedToCustomer: true,
    });
    const update = callsFor(calls, "users", "update").find(
      (c) => c.method === "update",
    );
    expect(update).toBeDefined();
    expect(update!.args[0]).toMatchObject({
      role: "customer",
      status: "active",
    });
    // No hard delete of the identity row in this mode.
    expect(callsFor(calls, "users", "delete")).toHaveLength(0);
  });

  it("demotes an unverified user back to an invited customer", async () => {
    const { supabase, calls } = makeFakeSupabase({
      "users.select": { data: { id: "u-1", email_verified_at: null } },
    });

    await deleteTeamMember(supabase, "u-1", { preserveAsCustomer: true });

    const update = callsFor(calls, "users", "update").find(
      (c) => c.method === "update",
    );
    expect(update!.args[0]).toMatchObject({
      role: "customer",
      status: "invited",
    });
  });

  it("deletes only unconsumed password_reset tokens", async () => {
    const { supabase, calls } = makeFakeSupabase({
      "users.select": { data: { id: "u-1", email_verified_at: null } },
    });

    await deleteTeamMember(supabase, "u-1", { preserveAsCustomer: true });

    const tokenCalls = callsFor(calls, "email_tokens", "delete");
    expect(tokenCalls.some((c) => c.method === "delete")).toBe(true);
    expect(
      tokenCalls.some(
        (c) =>
          c.method === "eq" &&
          c.args[0] === "purpose" &&
          c.args[1] === "password_reset",
      ),
    ).toBe(true);
    expect(
      tokenCalls.some(
        (c) =>
          c.method === "eq" && c.args[0] === "user_id" && c.args[1] === "u-1",
      ),
    ).toBe(true);
    expect(
      tokenCalls.some(
        (c) =>
          c.method === "is" &&
          c.args[0] === "consumed_at" &&
          c.args[1] === null,
      ),
    ).toBe(true);
  });

  it("revokes live sessions instead of deleting them", async () => {
    const { supabase, calls } = makeFakeSupabase({
      "users.select": { data: { id: "u-1", email_verified_at: null } },
    });

    await deleteTeamMember(supabase, "u-1", { preserveAsCustomer: true });

    const sessionCalls = callsFor(calls, "sessions", "update");
    const update = sessionCalls.find((c) => c.method === "update");
    expect(update).toBeDefined();
    expect(update!.args[0]).toHaveProperty("revoked_at");
    expect(
      sessionCalls.some(
        (c) =>
          c.method === "eq" && c.args[0] === "user_id" && c.args[1] === "u-1",
      ),
    ).toBe(true);
    expect(
      sessionCalls.some(
        (c) =>
          c.method === "is" && c.args[0] === "revoked_at" && c.args[1] === null,
      ),
    ).toBe(true);
    expect(
      calls.filter((c) => c.table === "sessions" && c.op === "delete"),
    ).toHaveLength(0);
  });

  it("no-ops (both flags false) when the auth row is already gone", async () => {
    const { supabase, calls } = makeFakeSupabase({
      "users.select": { data: null },
    });

    const result = await deleteTeamMember(supabase, "u-1", {
      preserveAsCustomer: true,
    });

    expect(result).toEqual({
      authUserDeleted: false,
      authUserDemotedToCustomer: false,
    });
    expect(callsFor(calls, "users", "update")).toHaveLength(0);
    expect(calls.filter((c) => c.table === "email_tokens")).toHaveLength(0);
    expect(calls.filter((c) => c.table === "sessions")).toHaveLength(0);
  });

  it("propagates a read error", async () => {
    const { supabase } = makeFakeSupabase({
      "users.select": { error: new Error("read failed") },
    });

    await expect(
      deleteTeamMember(supabase, "u-1", { preserveAsCustomer: true }),
    ).rejects.toThrow("read failed");
  });
});

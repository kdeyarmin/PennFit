// Tests for `countRecentFailures` in supabase-repository.ts.
//
// This PR fixes a DSL injection vulnerability: the previous implementation
// interpolated the email/IP value into a PostgREST `.or()` filter string.
// `normalizeEmail` permits `,` `.` `(` `)` in the local part, so a crafted
// address like `x,success.eq.true@a.com` could inject extra OR clauses —
// the count query would mis-parse or throw, and `checkLoginRateLimit`
// would then fail OPEN (silently disabling the per-email lockout).
//
// The fix uses chained `.eq()` calls which supabase-js parameterizes
// safely, making DSL injection impossible.
//
// Tests:
//   1. Returns 0 immediately when both emailLower and ip are falsy
//   2. Queries via .eq("email_lower") when only emailLower is given
//   3. Queries via .eq("ip") when only ip is given
//   4. Does NOT use .or() in either case (injection-safety contract)
//   5. Throws when supabase returns an error
//   6. Returns count from supabase response
//   7. Returns 0 when supabase returns null count
//   8. Does NOT chain both .eq("email_lower") and .eq("ip") when only
//      one is given (verifies the conditional application)

import { describe, expect, it, vi, beforeEach } from "vitest";

import { supabaseAuthRepository } from "./supabase-repository";
import type { ResupplySupabaseClient } from "@workspace/resupply-db";

// ── Fake query builder ────────────────────────────────────────────────────────
//
// Tracks which filter methods were called (and with what args) so tests can
// assert the injection-safe code path without standing up a real Supabase.

interface FakeQueryCall {
  method: string;
  args: unknown[];
}

interface FakeQueryResult {
  count?: number | null;
  error?: unknown;
}

function makeFakeSupabase(result: FakeQueryResult): {
  supabase: ResupplySupabaseClient;
  calls: FakeQueryCall[];
} {
  const calls: FakeQueryCall[] = [];

  const builder: Record<string, unknown> = {};

  // Every chainable method logs the call and returns the builder.
  const chainable =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };

  builder.select = chainable("select");
  builder.eq = chainable("eq");
  builder.neq = chainable("neq");
  builder.or = chainable("or");
  builder.gte = chainable("gte");
  builder.is = chainable("is");
  builder.lt = chainable("lt");
  builder.gt = chainable("gt");
  builder.limit = chainable("limit");
  builder.order = chainable("order");
  builder.maybeSingle = chainable("maybeSingle");
  builder.single = chainable("single");

  // `.then()` resolves the promise with the staged result.
  builder.then = (
    onFulfilled?: ((value: FakeQueryResult) => unknown) | null,
    onRejected?: ((reason: unknown) => unknown) | null,
  ) => Promise.resolve(result).then(onFulfilled, onRejected);

  const supabase = {
    schema: () => ({
      from: (_table: string) => builder,
      rpc: vi.fn(),
    }),
  } as unknown as ResupplySupabaseClient;

  return { supabase, calls };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("supabaseAuthRepository.countRecentFailures — injection-safety regression", () => {
  it("returns 0 immediately when both emailLower and ip are null (no DB call)", async () => {
    const { supabase, calls } = makeFakeSupabase({ count: 99 });
    const repo = supabaseAuthRepository(supabase);

    const result = await repo.countRecentFailures({
      emailLower: null,
      ip: null,
      sinceMs: 60_000,
    });

    expect(result).toBe(0);
    // The supabase chain must NOT have been exercised at all.
    expect(calls).toHaveLength(0);
  });

  it("returns 0 when both are empty strings (treated as falsy)", async () => {
    const { supabase, calls } = makeFakeSupabase({ count: 5 });
    const repo = supabaseAuthRepository(supabase);

    const result = await repo.countRecentFailures({
      emailLower: "",
      ip: "",
      sinceMs: 60_000,
    });

    expect(result).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("uses .eq('email_lower', value) when only emailLower is provided", async () => {
    const { supabase, calls } = makeFakeSupabase({ count: 3 });
    const repo = supabaseAuthRepository(supabase);

    await repo.countRecentFailures({
      emailLower: "alice@example.com",
      ip: null,
      sinceMs: 60_000,
    });

    const emailEq = calls.find(
      (c) => c.method === "eq" && c.args[0] === "email_lower",
    );
    expect(emailEq).toBeDefined();
    expect(emailEq!.args[1]).toBe("alice@example.com");
  });

  it("uses .eq('ip', value) when only ip is provided", async () => {
    const { supabase, calls } = makeFakeSupabase({ count: 2 });
    const repo = supabaseAuthRepository(supabase);

    await repo.countRecentFailures({
      emailLower: null,
      ip: "1.2.3.4",
      sinceMs: 60_000,
    });

    const ipEq = calls.find(
      (c) => c.method === "eq" && c.args[0] === "ip",
    );
    expect(ipEq).toBeDefined();
    expect(ipEq!.args[1]).toBe("1.2.3.4");
  });

  // Injection safety: the old code used .or("email_lower.eq.<value>") which
  // was vulnerable to DSL injection. The new code MUST NOT use .or() at all.
  it("does NOT call .or() when filtering by email (injection-safety contract)", async () => {
    const { supabase, calls } = makeFakeSupabase({ count: 1 });
    const repo = supabaseAuthRepository(supabase);

    await repo.countRecentFailures({
      emailLower: "x,success.eq.true@example.com",
      ip: null,
      sinceMs: 60_000,
    });

    const orCall = calls.find((c) => c.method === "or");
    expect(orCall).toBeUndefined();
  });

  it("does NOT call .or() when filtering by IP (injection-safety contract)", async () => {
    const { supabase, calls } = makeFakeSupabase({ count: 0 });
    const repo = supabaseAuthRepository(supabase);

    await repo.countRecentFailures({
      emailLower: null,
      ip: "1.2.3.4",
      sinceMs: 60_000,
    });

    const orCall = calls.find((c) => c.method === "or");
    expect(orCall).toBeUndefined();
  });

  it("does NOT apply .eq('ip') filter when only emailLower is provided", async () => {
    const { supabase, calls } = makeFakeSupabase({ count: 0 });
    const repo = supabaseAuthRepository(supabase);

    await repo.countRecentFailures({
      emailLower: "alice@example.com",
      ip: null,
      sinceMs: 60_000,
    });

    const ipEq = calls.find(
      (c) => c.method === "eq" && c.args[0] === "ip",
    );
    expect(ipEq).toBeUndefined();
  });

  it("does NOT apply .eq('email_lower') filter when only ip is provided", async () => {
    const { supabase, calls } = makeFakeSupabase({ count: 0 });
    const repo = supabaseAuthRepository(supabase);

    await repo.countRecentFailures({
      emailLower: null,
      ip: "10.0.0.1",
      sinceMs: 60_000,
    });

    const emailEq = calls.find(
      (c) => c.method === "eq" && c.args[0] === "email_lower",
    );
    expect(emailEq).toBeUndefined();
  });

  it("always applies .eq('success', false) as the base filter", async () => {
    const { supabase, calls } = makeFakeSupabase({ count: 0 });
    const repo = supabaseAuthRepository(supabase);

    await repo.countRecentFailures({
      emailLower: "alice@example.com",
      ip: null,
      sinceMs: 60_000,
    });

    const successEq = calls.find(
      (c) => c.method === "eq" && c.args[0] === "success",
    );
    expect(successEq).toBeDefined();
    expect(successEq!.args[1]).toBe(false);
  });

  it("applies .gte('attempted_at', since) as a time-window filter", async () => {
    const { supabase, calls } = makeFakeSupabase({ count: 0 });
    const repo = supabaseAuthRepository(supabase);

    const sinceMs = 5 * 60_000; // 5 minutes
    const before = Date.now();
    await repo.countRecentFailures({
      emailLower: "alice@example.com",
      ip: null,
      sinceMs,
    });
    const after = Date.now();

    const gteCall = calls.find((c) => c.method === "gte");
    expect(gteCall).toBeDefined();
    expect(gteCall!.args[0]).toBe("attempted_at");
    // The since ISO timestamp must be within the expected window.
    const sinceTs = new Date(gteCall!.args[1] as string).getTime();
    expect(sinceTs).toBeGreaterThanOrEqual(before - sinceMs - 100);
    expect(sinceTs).toBeLessThanOrEqual(after - sinceMs + 100);
  });

  it("returns the count from the supabase response", async () => {
    const { supabase } = makeFakeSupabase({ count: 7 });
    const repo = supabaseAuthRepository(supabase);

    const result = await repo.countRecentFailures({
      emailLower: "alice@example.com",
      ip: null,
      sinceMs: 60_000,
    });

    expect(result).toBe(7);
  });

  it("returns 0 when supabase returns null count", async () => {
    const { supabase } = makeFakeSupabase({ count: null });
    const repo = supabaseAuthRepository(supabase);

    const result = await repo.countRecentFailures({
      emailLower: "alice@example.com",
      ip: null,
      sinceMs: 60_000,
    });

    expect(result).toBe(0);
  });

  it("throws when supabase returns an error", async () => {
    const dbError = new Error("connection refused");
    const { supabase } = makeFakeSupabase({ error: dbError });
    const repo = supabaseAuthRepository(supabase);

    await expect(
      repo.countRecentFailures({
        emailLower: "alice@example.com",
        ip: null,
        sinceMs: 60_000,
      }),
    ).rejects.toThrow("connection refused");
  });

  // Boundary: injected metacharacter email should not cause a query crash
  // (with the old .or() interpolation this would either inject or throw;
  // the new .eq() approach passes the value safely as a parameter).
  it("passes an email with DSL metacharacters safely without throwing", async () => {
    const { supabase } = makeFakeSupabase({ count: 0 });
    const repo = supabaseAuthRepository(supabase);

    // Would have caused PostgREST DSL injection with the old .or() approach.
    await expect(
      repo.countRecentFailures({
        emailLower: "x,success.eq.true@example.com",
        ip: null,
        sinceMs: 60_000,
      }),
    ).resolves.toBe(0);
  });
});

import { describe, expect, it, vi } from "vitest";

import { checkLoginRateLimit, DEFAULT_RATE_LIMIT } from "./rate-limit";
import type { AuthRepository } from "./repository";

function fakeRepo(failures: { byEmail: number; byIp: number }): AuthRepository {
  // Most methods aren't called by the rate-limit check; throw if
  // they are, so a future bug there surfaces as a loud failure.
  const unused = (): never => {
    throw new Error("not used in rate-limit tests");
  };
  return {
    findUserByEmail: unused,
    findUserById: unused,
    insertUser: unused,
    markEmailVerified: unused,
    updateUserStatus: unused,
    findCredentialByUserId: unused,
    upsertCredential: unused,
    findSessionByTokenHash: unused,
    insertSession: unused,
    revokeSession: unused,
    revokeAllUserSessions: unused,
    revokeOtherUserSessions: unused,
    bumpSession: unused,
    insertEmailToken: unused,
    consumeEmailToken: unused,
    recordLoginAttempt: unused,
    async countRecentFailures(input) {
      if (input.emailLower !== null) return failures.byEmail;
      if (input.ip !== null) return failures.byIp;
      return 0;
    },
  };
}

describe("checkLoginRateLimit", () => {
  it("allows when both counters are below the threshold", async () => {
    const decision = await checkLoginRateLimit(
      fakeRepo({ byEmail: 0, byIp: 0 }),
      { emailLower: "alice@example.com", ip: "1.1.1.1" },
    );
    expect(decision.allowed).toBe(true);
  });

  it("locks on email when at the per-email max", async () => {
    const decision = await checkLoginRateLimit(
      fakeRepo({ byEmail: DEFAULT_RATE_LIMIT.maxPerEmail, byIp: 0 }),
      { emailLower: "alice@example.com", ip: "1.1.1.1" },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("email_locked");
  });

  it("locks on IP when at the per-IP max", async () => {
    const decision = await checkLoginRateLimit(
      fakeRepo({ byEmail: 0, byIp: DEFAULT_RATE_LIMIT.maxPerIp }),
      { emailLower: "alice@example.com", ip: "1.1.1.1" },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("ip_locked");
  });

  it("fails open on a repo error", async () => {
    const broken: AuthRepository = {
      ...fakeRepo({ byEmail: 0, byIp: 0 }),
      async countRecentFailures() {
        throw new Error("db down");
      },
    };
    const decision = await checkLoginRateLimit(
      broken,
      {
        emailLower: "alice@example.com",
        ip: "1.1.1.1",
      },
      DEFAULT_RATE_LIMIT,
      // Silence the default console.error so tests stay clean.
      () => {},
    );
    expect(decision.allowed).toBe(true);
  });

  it("invokes the onError hook with the input context on fail-open", async () => {
    const broken: AuthRepository = {
      ...fakeRepo({ byEmail: 0, byIp: 0 }),
      async countRecentFailures() {
        throw new Error("db down");
      },
    };
    const calls: Array<{
      err: unknown;
      ctx: { emailLower: string; ip: string | null };
    }> = [];
    const decision = await checkLoginRateLimit(
      broken,
      { emailLower: "alice@example.com", ip: "1.1.1.1" },
      DEFAULT_RATE_LIMIT,
      (err, ctx) => calls.push({ err, ctx }),
    );
    expect(decision.allowed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ctx).toEqual({
      emailLower: "alice@example.com",
      ip: "1.1.1.1",
    });
    expect(calls[0]!.err).toBeInstanceOf(Error);
  });

  it("swallows a throwing onError so observability never blocks the gate", async () => {
    const broken: AuthRepository = {
      ...fakeRepo({ byEmail: 0, byIp: 0 }),
      async countRecentFailures() {
        throw new Error("db down");
      },
    };
    const decision = await checkLoginRateLimit(
      broken,
      { emailLower: "alice@example.com", ip: "1.1.1.1" },
      DEFAULT_RATE_LIMIT,
      () => {
        throw new Error("logger blew up");
      },
    );
    expect(decision.allowed).toBe(true);
  });

  it("ignores per-IP check when IP is null", async () => {
    // fakeRepo returns byIp=999 for any IP-keyed query; passing
    // ip:null should still allow because the IP query is skipped.
    const decision = await checkLoginRateLimit(
      fakeRepo({ byEmail: 0, byIp: 999 }),
      { emailLower: "alice@example.com", ip: null },
    );
    expect(decision.allowed).toBe(true);
  });

  // Additional tests for the onError hook and defaultErrorHandler added in this PR.

  it("passes non-Error throw values (strings) to the onError hook as-is", async () => {
    // The catch block does `onError(err, input)` for ANY throw — the hook
    // receives the raw thrown value, not a wrapped Error. Callers who pass
    // `err instanceof Error ? err.message : String(err)` must handle this.
    const broken: AuthRepository = {
      ...fakeRepo({ byEmail: 0, byIp: 0 }),
      async countRecentFailures() {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "string-thrown error";
      },
    };
    const received: unknown[] = [];
    await checkLoginRateLimit(
      broken,
      { emailLower: "alice@example.com", ip: "1.1.1.1" },
      DEFAULT_RATE_LIMIT,
      (err) => received.push(err),
    );
    expect(received).toHaveLength(1);
    expect(received[0]).toBe("string-thrown error");
  });

  it("passes the exact input context (emailLower, ip=null) to onError when ip is null", async () => {
    const broken: AuthRepository = {
      ...fakeRepo({ byEmail: 0, byIp: 0 }),
      async countRecentFailures() {
        throw new Error("db unreachable");
      },
    };
    const contexts: Array<{ emailLower: string; ip: string | null }> = [];
    await checkLoginRateLimit(
      broken,
      { emailLower: "__forgot:10.0.0.1", ip: null },
      DEFAULT_RATE_LIMIT,
      (_err, ctx) => contexts.push(ctx),
    );
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toEqual({ emailLower: "__forgot:10.0.0.1", ip: null });
  });

  it("calls console.error with the error message when no onError is provided (defaultErrorHandler)", async () => {
    // The defaultErrorHandler is the fallback used when callers omit onError.
    // Verify it surfaces the error via console.error so ops tools can pick it up.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const broken: AuthRepository = {
        ...fakeRepo({ byEmail: 0, byIp: 0 }),
        async countRecentFailures() {
          throw new Error("db is down");
        },
      };
      // Omit onError → defaultErrorHandler is used.
      const decision = await checkLoginRateLimit(
        broken,
        { emailLower: "alice@example.com", ip: "1.1.1.1" },
        DEFAULT_RATE_LIMIT,
        // explicitly pass undefined to trigger the default
        undefined,
      );
      expect(decision.allowed).toBe(true);
      expect(errorSpy).toHaveBeenCalledOnce();
      // The message should mention the library name and the error message.
      const [msg] = errorSpy.mock.calls[0]!;
      expect(String(msg)).toContain("resupply-auth");
      expect(String(msg)).toContain("fail-open");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("returns retryAfterSeconds derived from windowMs when email-locked", async () => {
    const config = { maxPerEmail: 3, maxPerIp: 30, windowMs: 5 * 60 * 1000 }; // 5 min
    const decision = await checkLoginRateLimit(
      fakeRepo({ byEmail: 3, byIp: 0 }),
      { emailLower: "alice@example.com", ip: "1.1.1.1" },
      config,
      () => {},
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("email_locked");
    // retryAfterSeconds = ceil(windowMs / 1000) = 300
    expect(decision.retryAfterSeconds).toBe(300);
  });

  it("allows at exactly maxPerEmail - 1 failures (boundary check)", async () => {
    const decision = await checkLoginRateLimit(
      fakeRepo({
        byEmail: DEFAULT_RATE_LIMIT.maxPerEmail - 1,
        byIp: 0,
      }),
      { emailLower: "alice@example.com", ip: "1.1.1.1" },
      DEFAULT_RATE_LIMIT,
      () => {},
    );
    expect(decision.allowed).toBe(true);
    expect(decision.retryAfterSeconds).toBe(0);
  });
});

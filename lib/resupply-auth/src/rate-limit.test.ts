import { describe, expect, it } from "vitest";

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
});

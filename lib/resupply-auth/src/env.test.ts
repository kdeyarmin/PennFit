import { describe, expect, it } from "vitest";

import { readAuthEnv } from "./env";

describe("readAuthEnv", () => {
  it("returns sane defaults for missing TTLs", () => {
    const env = readAuthEnv({});
    expect(env.sessionTtlDays).toBe(14);
    expect(env.emailTokenTtlHours).toBe(24);
  });

  it("ignores any AUTH_PROVIDER value the caller sets (legacy compat)", () => {
    // Legacy deploys may still have a stale AUTH_PROVIDER value in
    // their env. We accept and ignore — the in-house path is the
    // only path now.
    const env = readAuthEnv({
      AUTH_PROVIDER: "external",
    });
    expect(env.sessionTtlDays).toBe(14);
  });

  it("ignores any AUTH_PASSWORD_PEPPER value the caller sets (legacy compat)", () => {
    // Legacy deploys may still have a stale AUTH_PASSWORD_PEPPER
    // value in their env. The pepper was removed from the auth
    // surface; we accept and ignore so removed-but-not-yet-cleared
    // env vars don't crash a service that's being upgraded in
    // place.
    const env = readAuthEnv({
      AUTH_PASSWORD_PEPPER: "anything-or-nothing",
    });
    expect(env).not.toHaveProperty("passwordPepper");
    expect(env.sessionTtlDays).toBe(14);
  });

  it("parses positive integer TTLs and rejects bad ones", () => {
    const env = readAuthEnv({
      AUTH_SESSION_TTL_DAYS: "30",
      AUTH_EMAIL_TOKEN_TTL_HOURS: "2",
    });
    expect(env.sessionTtlDays).toBe(30);
    expect(env.emailTokenTtlHours).toBe(2);

    expect(() =>
      readAuthEnv({
        AUTH_SESSION_TTL_DAYS: "0",
      }),
    ).toThrow();
    expect(() =>
      readAuthEnv({
        AUTH_SESSION_TTL_DAYS: "-1",
      }),
    ).toThrow();
    expect(() =>
      readAuthEnv({
        AUTH_SESSION_TTL_DAYS: "two weeks",
      }),
    ).toThrow();
  });
});

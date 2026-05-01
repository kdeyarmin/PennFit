import { describe, expect, it } from "vitest";

import { readAuthEnv } from "./env";

const PEPPER_BASE64 =
  "Zm9yIHRlc3Rpbmcgb25seSBwbGVhc2UgZG8gbm90IHJldXNlIGFhYWFhYWE="; // 40 bytes when decoded

describe("readAuthEnv", () => {
  it("returns sane defaults for missing TTLs", () => {
    const env = readAuthEnv({ AUTH_PASSWORD_PEPPER: PEPPER_BASE64 });
    expect(env.sessionTtlDays).toBe(14);
    expect(env.emailTokenTtlHours).toBe(24);
  });

  it("ignores any AUTH_PROVIDER value the caller sets (legacy compat)", () => {
    // Legacy deploys may still have AUTH_PROVIDER=clerk in their
    // env. We accept and ignore — the in-house path is the only
    // path now.
    const env = readAuthEnv({
      AUTH_PROVIDER: "clerk",
      AUTH_PASSWORD_PEPPER: PEPPER_BASE64,
    });
    expect(env.passwordPepper.length).toBeGreaterThanOrEqual(32);
  });

  it("requires AUTH_PASSWORD_PEPPER unconditionally", () => {
    expect(() => readAuthEnv({})).toThrow(
      /AUTH_PASSWORD_PEPPER is required/,
    );
  });

  it("rejects pepper shorter than 32 bytes", () => {
    // 16 bytes when decoded
    const tooShort = Buffer.from("a".repeat(16)).toString("base64");
    expect(() =>
      readAuthEnv({ AUTH_PASSWORD_PEPPER: tooShort }),
    ).toThrow(/at least 32 bytes/);
  });

  it("parses positive integer TTLs and rejects bad ones", () => {
    const env = readAuthEnv({
      AUTH_PASSWORD_PEPPER: PEPPER_BASE64,
      AUTH_SESSION_TTL_DAYS: "30",
      AUTH_EMAIL_TOKEN_TTL_HOURS: "2",
    });
    expect(env.sessionTtlDays).toBe(30);
    expect(env.emailTokenTtlHours).toBe(2);

    expect(() =>
      readAuthEnv({
        AUTH_PASSWORD_PEPPER: PEPPER_BASE64,
        AUTH_SESSION_TTL_DAYS: "0",
      }),
    ).toThrow();
    expect(() =>
      readAuthEnv({
        AUTH_PASSWORD_PEPPER: PEPPER_BASE64,
        AUTH_SESSION_TTL_DAYS: "-1",
      }),
    ).toThrow();
    expect(() =>
      readAuthEnv({
        AUTH_PASSWORD_PEPPER: PEPPER_BASE64,
        AUTH_SESSION_TTL_DAYS: "two weeks",
      }),
    ).toThrow();
  });

  it("decodes a 32+ byte pepper into a Buffer", () => {
    const env = readAuthEnv({ AUTH_PASSWORD_PEPPER: PEPPER_BASE64 });
    expect(env.passwordPepper).toBeInstanceOf(Buffer);
    expect(env.passwordPepper.length).toBeGreaterThanOrEqual(32);
  });
});

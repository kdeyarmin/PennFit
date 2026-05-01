import { describe, expect, it } from "vitest";

import { isInHouseAuthActive, readAuthEnv } from "./env";

const PEPPER_BASE64 =
  "Zm9yIHRlc3Rpbmcgb25seSBwbGVhc2UgZG8gbm90IHJldXNlIGFhYWFhYWE="; // 40 bytes when decoded

describe("readAuthEnv", () => {
  it("defaults provider to 'clerk' and skips pepper", () => {
    const env = readAuthEnv({});
    expect(env.provider).toBe("clerk");
    expect(env.passwordPepper).toBeNull();
    expect(env.sessionTtlDays).toBe(14);
    expect(env.emailTokenTtlHours).toBe(24);
  });

  it("isInHouseAuthActive is false for clerk and true otherwise", () => {
    expect(isInHouseAuthActive(readAuthEnv({}))).toBe(false);
    expect(
      isInHouseAuthActive(
        readAuthEnv({
          AUTH_PROVIDER: "dual",
          AUTH_PASSWORD_PEPPER: PEPPER_BASE64,
        }),
      ),
    ).toBe(true);
    expect(
      isInHouseAuthActive(
        readAuthEnv({
          AUTH_PROVIDER: "in_house",
          AUTH_PASSWORD_PEPPER: PEPPER_BASE64,
        }),
      ),
    ).toBe(true);
  });

  it("requires pepper when provider is dual or in_house", () => {
    expect(() => readAuthEnv({ AUTH_PROVIDER: "dual" })).toThrow(
      /AUTH_PASSWORD_PEPPER is required/,
    );
    expect(() => readAuthEnv({ AUTH_PROVIDER: "in_house" })).toThrow(
      /AUTH_PASSWORD_PEPPER is required/,
    );
  });

  it("rejects pepper shorter than 32 bytes", () => {
    // 16 bytes when decoded
    const tooShort = Buffer.from("a".repeat(16)).toString("base64");
    expect(() =>
      readAuthEnv({
        AUTH_PROVIDER: "in_house",
        AUTH_PASSWORD_PEPPER: tooShort,
      }),
    ).toThrow(/at least 32 bytes/);
  });

  it("rejects unknown provider values", () => {
    expect(() => readAuthEnv({ AUTH_PROVIDER: "supabase" })).toThrow();
  });

  it("parses positive integer TTLs and rejects bad ones", () => {
    const env = readAuthEnv({
      AUTH_SESSION_TTL_DAYS: "30",
      AUTH_EMAIL_TOKEN_TTL_HOURS: "2",
    });
    expect(env.sessionTtlDays).toBe(30);
    expect(env.emailTokenTtlHours).toBe(2);

    expect(() => readAuthEnv({ AUTH_SESSION_TTL_DAYS: "0" })).toThrow();
    expect(() => readAuthEnv({ AUTH_SESSION_TTL_DAYS: "-1" })).toThrow();
    expect(() =>
      readAuthEnv({ AUTH_SESSION_TTL_DAYS: "two weeks" }),
    ).toThrow();
  });

  it("decodes a 32+ byte pepper into a Buffer", () => {
    const env = readAuthEnv({
      AUTH_PROVIDER: "in_house",
      AUTH_PASSWORD_PEPPER: PEPPER_BASE64,
    });
    expect(env.passwordPepper).toBeInstanceOf(Buffer);
    expect(env.passwordPepper!.length).toBeGreaterThanOrEqual(32);
  });
});

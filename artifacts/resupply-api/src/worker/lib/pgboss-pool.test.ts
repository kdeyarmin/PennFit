import { describe, expect, it } from "vitest";

import { DEFAULT_PGBOSS_POOL_MAX, resolvePgBossPoolMax } from "./pgboss-pool";

describe("resolvePgBossPoolMax", () => {
  it("uses the default when unset", () => {
    expect(resolvePgBossPoolMax(undefined)).toBe(DEFAULT_PGBOSS_POOL_MAX);
  });

  it("uses the default for an empty / whitespace value", () => {
    expect(resolvePgBossPoolMax("")).toBe(DEFAULT_PGBOSS_POOL_MAX);
    expect(resolvePgBossPoolMax("   ")).toBe(DEFAULT_PGBOSS_POOL_MAX);
  });

  it("honors a valid positive override", () => {
    expect(resolvePgBossPoolMax("3")).toBe(3);
    expect(resolvePgBossPoolMax("12")).toBe(12);
  });

  it("falls back on zero, negative, or non-numeric values", () => {
    expect(resolvePgBossPoolMax("0")).toBe(DEFAULT_PGBOSS_POOL_MAX);
    expect(resolvePgBossPoolMax("-4")).toBe(DEFAULT_PGBOSS_POOL_MAX);
    expect(resolvePgBossPoolMax("abc")).toBe(DEFAULT_PGBOSS_POOL_MAX);
  });

  it("honors an explicit fallback", () => {
    expect(resolvePgBossPoolMax(undefined, 2)).toBe(2);
    expect(resolvePgBossPoolMax("nope", 2)).toBe(2);
  });
});

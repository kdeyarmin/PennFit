import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetDbPoolForTests, getDbPool } from "./pool";

// These are pure smoke tests for the pool helper itself. They never
// actually connect — `pg.Pool` is lazy, so constructing it without
// calling `query()` or `connect()` does not open a TCP connection.

describe("@workspace/resupply-db getDbPool()", () => {
  let originalUrl: string | undefined;

  beforeEach(() => {
    originalUrl = process.env.DATABASE_URL;
    __resetDbPoolForTests();
  });

  afterEach(() => {
    if (originalUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalUrl;
    }
    __resetDbPoolForTests();
  });

  it("throws a clear error when DATABASE_URL is missing", () => {
    delete process.env.DATABASE_URL;
    expect(() => getDbPool()).toThrow(/DATABASE_URL must be set/);
  });

  it("returns the same Pool instance on repeated calls (singleton)", () => {
    process.env.DATABASE_URL = "postgres://stub:stub@localhost:5432/stub";
    const a = getDbPool();
    const b = getDbPool();
    expect(a).toBe(b);
  });

  it("returns a fresh instance after __resetDbPoolForTests()", () => {
    process.env.DATABASE_URL = "postgres://stub:stub@localhost:5432/stub";
    const a = getDbPool();
    __resetDbPoolForTests();
    const b = getDbPool();
    expect(a).not.toBe(b);
  });
});

import { describe, expect, it } from "vitest";

import {
  hashPassword,
  needsRehash,
  verifyPassword,
  verifyPasswordCredential,
} from "./password";

// Argon2 hashing is intentionally slow. Use weak params for tests so
// the suite stays fast — we only care about correctness here, not
// the production parameter values.
const FAST_PARAMS = { memoryCost: 1024, timeCost: 1, parallelism: 1 };

describe("hashPassword + verifyPassword", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("hunter2", FAST_PARAMS);
    expect(hash.startsWith("$argon2id$")).toBe(true);
    await expect(verifyPassword("hunter2", hash)).resolves.toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("hunter2", FAST_PARAMS);
    await expect(verifyPassword("wrong", hash)).resolves.toBe(false);
  });

  it("returns false (not throws) on malformed stored hash", async () => {
    await expect(
      verifyPassword("hunter2", "not-an-argon2-hash"),
    ).resolves.toBe(false);
  });
});

describe("verifyPasswordCredential — algo dispatch", () => {
  it("verifies argon2id-v1 credentials", async () => {
    const hash = await hashPassword("hunter2", FAST_PARAMS);
    const result = await verifyPasswordCredential("hunter2", {
      passwordHash: hash,
      algo: "argon2id-v1",
    });
    expect(result).toEqual({ ok: true, needsRehash: false });
  });

  it("treats a missing algo as argon2id-v1 (back-compat with rows missing the tag)", async () => {
    const hash = await hashPassword("hunter2", FAST_PARAMS);
    const result = await verifyPasswordCredential("hunter2", {
      passwordHash: hash,
    });
    expect(result.ok).toBe(true);
  });

  it("fails closed on an unknown algo tag", async () => {
    const result = await verifyPasswordCredential("anything", {
      passwordHash: "anything",
      algo: "wat" as unknown as "argon2id-v1",
    });
    expect(result).toEqual({ ok: false, needsRehash: false });
  });
});

describe("needsRehash", () => {
  it("flags a hash produced with weaker params than the current target", async () => {
    const weak = await hashPassword("hunter2", FAST_PARAMS);
    // Default target is much stronger than FAST_PARAMS, so it
    // should report "needs rehash".
    expect(needsRehash(weak)).toBe(true);
  });

  it("does not flag a hash produced with the current target", async () => {
    const target = { memoryCost: 4096, timeCost: 2, parallelism: 1 };
    const fresh = await hashPassword("hunter2", target);
    expect(needsRehash(fresh, target)).toBe(false);
  });
});

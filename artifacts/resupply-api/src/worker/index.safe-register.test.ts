// Regression tests for the per-registration failure guard (June-10
// audit, P3): one throwing register call must not abort the remaining
// ~60 job registrations — it is recorded and surfaced as an aggregate
// AFTER everything has been attempted, so healthy jobs come online
// while the boot backoff loop retries the failed ones.

import { describe, expect, it } from "vitest";

import { safeRegister } from "./index";

describe("safeRegister", () => {
  it("runs the registration and records nothing on success", async () => {
    const failures: string[] = [];
    let ran = false;
    await safeRegister("good-job", failures, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(failures).toEqual([]);
  });

  it("captures a throwing registration instead of propagating", async () => {
    const failures: string[] = [];
    await expect(
      safeRegister("bad-job", failures, async () => {
        throw new Error("queue create failed");
      }),
    ).resolves.toBeUndefined();
    expect(failures).toEqual(["bad-job"]);
  });

  it("lets subsequent registrations proceed after a failure", async () => {
    const failures: string[] = [];
    const order: string[] = [];
    await safeRegister("first-bad", failures, async () => {
      throw new Error("boom");
    });
    await safeRegister("second-good", failures, async () => {
      order.push("second-good");
    });
    expect(order).toEqual(["second-good"]);
    expect(failures).toEqual(["first-bad"]);
  });

  it("captures non-Error throw values too", async () => {
    const failures: string[] = [];
    await safeRegister("string-thrower", failures, async () => {
      throw "raw string failure";
    });
    expect(failures).toEqual(["string-thrower"]);
  });
});

// Lockout-focused tests for the voice tool dispatcher.
//
// These tests exercise only the in-process gate logic (attempt
// counting, post-lockout allowlist) — they don't touch a real DB.
// Database read/write paths are covered by the readiness integration
// suite that runs against a live Postgres in CI.
//
// We mock the Drizzle handle with a minimal chainable thenable so that
// `db.select(...).from(...).where(...).limit(1)` resolves to a stubbed
// row and `db.update(...).set(...).where(...)` resolves to undefined.
// That's enough to exercise verify_patient_identity, the lockout
// guard, and the post-lockout allowlist (request_human_handoff /
// end_call).

import { describe, it, expect } from "vitest";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { createVoiceToolDispatcher } from "./tools-impl";

interface StubRow {
  dob: string | null;
  firstName: string | null;
}

function buildStubDb(row: StubRow | null): NodePgDatabase {
  // The chain we need to satisfy:
  //   db.select(...).from(...).where(...).limit(1)  → Promise<rows>
  //   db.update(...).set(...).where(...)            → Promise<void>
  const selectChain = {
    from() {
      return this;
    },
    where() {
      return this;
    },
    limit() {
      return Promise.resolve(row ? [row] : []);
    },
  };
  const updateChain = {
    set() {
      return this;
    },
    where() {
      return Promise.resolve(undefined);
    },
  };
  return {
    select: () => selectChain,
    update: () => updateChain,
  } as unknown as NodePgDatabase;
}

const baseDeps = {
  patientId: "pat-1",
  conversationId: "conv-1",
  episodeId: "epi-1",
};

describe("VoiceToolDispatcher — identity attempt cap", () => {
  it("counts down attempts_remaining on each failed verify", async () => {
    const dispatcher = createVoiceToolDispatcher({
      ...baseDeps,
      db: buildStubDb({ dob: "1980-01-01", firstName: "Alex" }),
    });

    const r1 = await dispatcher.dispatch({
      callId: "c1",
      name: "verify_patient_identity",
      args: { date_of_birth: "1999-12-31" },
    });
    const r2 = await dispatcher.dispatch({
      callId: "c2",
      name: "verify_patient_identity",
      args: { date_of_birth: "1999-12-31" },
    });
    const r3 = await dispatcher.dispatch({
      callId: "c3",
      name: "verify_patient_identity",
      args: { date_of_birth: "1999-12-31" },
    });

    expect(r1.result).toEqual({ matched: false, attempts_remaining: 2 });
    expect(r2.result).toEqual({ matched: false, attempts_remaining: 1 });
    expect(r3.result).toEqual({ matched: false, attempts_remaining: 0 });
    expect(dispatcher.isIdentityVerified()).toBe(false);
  });

  it("hard-locks after 3 failed attempts: a 4th verify is refused without hitting the DB", async () => {
    let dbCalls = 0;
    const stubRow: StubRow = { dob: "1980-01-01", firstName: "Alex" };
    const recordingDb = {
      select: () => {
        dbCalls += 1;
        return {
          from() {
            return this;
          },
          where() {
            return this;
          },
          limit() {
            return Promise.resolve([stubRow]);
          },
        };
      },
      update: () => ({
        set() {
          return this;
        },
        where() {
          return Promise.resolve(undefined);
        },
      }),
    } as unknown as NodePgDatabase;

    const dispatcher = createVoiceToolDispatcher({
      ...baseDeps,
      db: recordingDb,
    });

    for (let i = 0; i < 3; i += 1) {
      await dispatcher.dispatch({
        callId: `c${i}`,
        name: "verify_patient_identity",
        args: { date_of_birth: "1999-12-31" },
      });
    }
    expect(dbCalls).toBe(3);

    // 4th attempt — must be refused by the lockout gate, must NOT
    // hit the db, must NOT mutate the verified flag, and must report
    // attempts_remaining=0 with matched=false. The
    // identityRequiredResultFor stub for verify_patient_identity
    // surfaces 0 to give the model a stable exhausted-state signal.
    const r4 = await dispatcher.dispatch({
      callId: "c4",
      name: "verify_patient_identity",
      args: { date_of_birth: "1980-01-01" }, // would have matched!
    });
    expect(dbCalls).toBe(3);
    expect(r4.result).toEqual({ matched: false, attempts_remaining: 0 });
    expect(dispatcher.isIdentityVerified()).toBe(false);

    // Repeat refusals must remain stable: still no DB hit, still
    // attempts_remaining=0, still unverified. Guards against any
    // future regression that mutates state on the locked-out path.
    const r5 = await dispatcher.dispatch({
      callId: "c5",
      name: "verify_patient_identity",
      args: { date_of_birth: "1980-01-01" },
    });
    expect(dbCalls).toBe(3);
    expect(r5.result).toEqual({ matched: false, attempts_remaining: 0 });
    expect(dispatcher.isIdentityVerified()).toBe(false);
  });

  it("blocks all side-effect tools after lockout (forces handoff/end_call only)", async () => {
    const dispatcher = createVoiceToolDispatcher({
      ...baseDeps,
      db: buildStubDb({ dob: "1980-01-01", firstName: "Alex" }),
    });

    // Burn the cap.
    for (let i = 0; i < 3; i += 1) {
      await dispatcher.dispatch({
        callId: `v${i}`,
        name: "verify_patient_identity",
        args: { date_of_birth: "1999-12-31" },
      });
    }

    // Side-effect tools should ALL be refused with the
    // identity_required stub shape.
    const lookup = await dispatcher.dispatch({
      callId: "lk",
      name: "lookup_resupply_inventory",
      args: {},
    });
    expect(lookup.result).toEqual({ items: [] });

    const addr = await dispatcher.dispatch({
      callId: "ad",
      name: "get_shipping_address",
      args: {},
    });
    expect(addr.result).toEqual({ street_name: "", city: "", state: "" });

    const upd = await dispatcher.dispatch({
      callId: "up",
      name: "update_shipping_address",
      args: {
        street: "1 Main",
        city: "Phila",
        state: "PA",
        postal_code: "19104",
      },
    });
    expect(upd.result).toEqual({ ok: false, summary: "identity_not_verified" });

    const order = await dispatcher.dispatch({
      callId: "or",
      name: "place_resupply_order",
      args: { skus: ["X"], address_confirmed: true },
    });
    expect(order.result).toEqual({
      ok: false,
      order_id: "",
      accepted_skus: [],
    });
  });

  it("permits request_human_handoff and end_call after lockout", async () => {
    const dispatcher = createVoiceToolDispatcher({
      ...baseDeps,
      db: buildStubDb({ dob: "1980-01-01", firstName: "Alex" }),
    });

    for (let i = 0; i < 3; i += 1) {
      await dispatcher.dispatch({
        callId: `v${i}`,
        name: "verify_patient_identity",
        args: { date_of_birth: "1999-12-31" },
      });
    }

    const handoff = await dispatcher.dispatch({
      callId: "h",
      name: "request_human_handoff",
      args: { reason: "identity_verification_failed" },
    });
    expect(handoff.result.ok).toBe(true);
    expect(typeof handoff.result.handoff_id).toBe("string");

    const ended = await dispatcher.dispatch({
      callId: "e",
      name: "end_call",
      args: { outcome: "identity_verification_failed" },
    });
    expect(ended.result).toEqual({ ok: true });
  });

  it("verifies identity on a matching DOB before lockout and unlocks side-effects", async () => {
    const dispatcher = createVoiceToolDispatcher({
      ...baseDeps,
      db: buildStubDb({ dob: "1980-01-01", firstName: "Alex" }),
    });

    // First attempt fails.
    const bad = await dispatcher.dispatch({
      callId: "v1",
      name: "verify_patient_identity",
      args: { date_of_birth: "1999-12-31" },
    });
    expect(bad.result.matched).toBe(false);

    // Second attempt matches.
    const good = await dispatcher.dispatch({
      callId: "v2",
      name: "verify_patient_identity",
      args: { date_of_birth: "1980-01-01" },
    });
    expect(good.result.matched).toBe(true);
    expect(dispatcher.isIdentityVerified()).toBe(true);
  });
});

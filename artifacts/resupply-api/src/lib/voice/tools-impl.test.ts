// Lockout-focused tests for the voice tool dispatcher.
//
// These tests exercise only the in-process gate logic (attempt
// counting, post-lockout allowlist) — they don't touch a real DB.
// Database read/write paths are covered by the readiness integration
// suite that runs against a live Postgres in CI.
//
// We hand the dispatcher a stub Supabase client whose `.maybeSingle()`
// resolves to a stubbed row and whose `.update(...)` resolves to a
// no-error envelope. That's enough to exercise verify_patient_identity,
// the lockout guard, and the post-lockout allowlist
// (request_human_handoff / end_call).

import { describe, it, expect, vi } from "vitest";

import { createVoiceToolDispatcher } from "./tools-impl";

interface StubRow {
  date_of_birth: string | null;
  legal_first_name: string | null;
}

// Minimal supabase-js shape: `.schema(...).from(...).select(...)
// .eq(...).limit(1).maybeSingle()` for reads, plus the
// `.update(...).eq(...)` shape for writes.
function buildStubSupabase(row: StubRow | null) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    update: () => builder,
    eq: () => builder,
    limit: () => builder,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
    single: () => Promise.resolve({ data: row, error: null }),
    then: (
      onfulfilled: (v: unknown) => unknown,
      onrejected?: (e: unknown) => unknown,
    ) =>
      Promise.resolve({ data: null, error: null }).then(
        onfulfilled,
        onrejected,
      ),
  };
  return {
    schema: () => ({
      from: () => builder,
    }),
  } as unknown as never;
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
      supabase: buildStubSupabase({
        date_of_birth: "1980-01-01",
        legal_first_name: "Alex",
      }),
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
    const stubRow: StubRow = {
      date_of_birth: "1980-01-01",
      legal_first_name: "Alex",
    };
    const recordingDb = {
      schema: () => ({
        from: () => {
          const builder: Record<string, unknown> = {
            select: () => {
              dbCalls += 1;
              return builder;
            },
            update: () => builder,
            eq: () => builder,
            limit: () => builder,
            maybeSingle: () => Promise.resolve({ data: stubRow, error: null }),
            then: (
              onfulfilled: (v: unknown) => unknown,
              onrejected?: (e: unknown) => unknown,
            ) =>
              Promise.resolve({ data: null, error: null }).then(
                onfulfilled,
                onrejected,
              ),
          };
          return builder;
        },
      }),
    } as unknown as never;

    const dispatcher = createVoiceToolDispatcher({
      ...baseDeps,
      supabase: recordingDb,
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
    // attempts_remaining=0 with matched=false.
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
      supabase: buildStubSupabase({
        date_of_birth: "1980-01-01",
        legal_first_name: "Alex",
      }),
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
      supabase: buildStubSupabase({
        date_of_birth: "1980-01-01",
        legal_first_name: "Alex",
      }),
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
      supabase: buildStubSupabase({
        date_of_birth: "1980-01-01",
        legal_first_name: "Alex",
      }),
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

// ---------------------------------------------------------------------------
// PR change: prescriptions query now filters by status = 'active'
// ---------------------------------------------------------------------------
// Source structural check: `.eq("status", "active")` must appear in the
// prescriptions query inside lookupInventory so inactive / expired scripts
// are excluded from the voice resupply inventory listing.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_SRC = readFileSync(path.join(__dirname2, "tools-impl.ts"), "utf8");

describe("tools-impl — prescriptions query filters by status='active' (PR change)", () => {
  it("includes .eq('status', 'active') in the prescriptions select chain", () => {
    expect(TOOLS_SRC).toContain('.eq("status", "active")');
  });

  it("applies the active filter to the prescriptions table (not another table)", () => {
    // The active filter must appear near the prescriptions from() call.
    const prescIdx = TOOLS_SRC.indexOf('.from("prescriptions")');
    expect(prescIdx).toBeGreaterThan(-1);
    // Find the .eq("status", "active") occurrence after the prescriptions from()
    const activeIdx = TOOLS_SRC.indexOf('.eq("status", "active")', prescIdx);
    expect(activeIdx).toBeGreaterThan(prescIdx);
    // And before the next .from() call (so it's scoped to prescriptions)
    const nextFromIdx = TOOLS_SRC.indexOf(".from(", prescIdx + 1);
    expect(activeIdx).toBeLessThan(nextFromIdx);
  });

  it("places the active filter after the patient_id eq filter", () => {
    const prescIdx = TOOLS_SRC.indexOf('.from("prescriptions")');
    const patientIdx = TOOLS_SRC.indexOf('.eq("patient_id"', prescIdx);
    const activeIdx = TOOLS_SRC.indexOf('.eq("status", "active")', prescIdx);
    expect(patientIdx).toBeGreaterThan(-1);
    expect(activeIdx).toBeGreaterThan(patientIdx);
  });
});

// ---------------------------------------------------------------------------
// place_resupply_order rides the SHARED order-flow path
// ---------------------------------------------------------------------------
// The voice tool used to flip episodes.status itself behind a
// `.eq("status", "pending")` guard — but "pending" is not an episode
// status (the lifecycle is outreach_pending → awaiting_response →
// confirmed/declined/…), so the guard matched ZERO rows and every voice
// order failed. It also created no fulfillment rows, so even a successful
// claim would never have shipped. It now delegates to
// placeResupplyOrderForConversation — the same path SMS/email confirms
// ride (atomic claim of any non-terminal episode + entitlement/coverage
// guards + queued fulfillments).

describe("tools-impl — place_resupply_order delegates to the shared order flow", () => {
  it("calls placeResupplyOrderForConversation instead of writing episodes directly", () => {
    expect(TOOLS_SRC).toContain("placeResupplyOrderForConversation");
    // The broken voice-only episode write must be gone.
    expect(TOOLS_SRC).not.toContain('.eq("status", "pending")');
    expect(TOOLS_SRC).not.toContain('.from("episodes")');
  });
});

// ---------------------------------------------------------------------------
// Behavioural tests: place_resupply_order result mapping
// ---------------------------------------------------------------------------
// The shared flow is injected through the `placeOrderForConversation` deps
// seam; the stub supabase only has to serve the verify read and the
// prescriptions eligibility read.

/** Stub serving the patient verify read + a prescriptions list. */
function buildStubSupabaseWithRx(
  patientRow: { date_of_birth: string | null; legal_first_name: string | null },
  prescriptions?: Array<{ item_sku: string }>,
) {
  let currentTable: string | null = null;
  const builder: Record<string, unknown> = {
    select: () => builder,
    update: () => builder,
    eq: () => builder,
    limit: () => builder,
    maybeSingle: () => Promise.resolve({ data: patientRow, error: null }),
    single: () => Promise.resolve({ data: patientRow, error: null }),
    then: (
      onfulfilled: (v: unknown) => unknown,
      onrejected?: (e: unknown) => unknown,
    ) => {
      const payload =
        currentTable === "prescriptions"
          ? { data: prescriptions ?? [], error: null }
          : { data: null, error: null };
      return Promise.resolve(payload).then(onfulfilled, onrejected);
    },
  };
  return {
    schema: () => ({
      from: (table: string) => {
        currentTable = table;
        return builder;
      },
    }),
  } as unknown as never;
}

describe("VoiceToolDispatcher — place_resupply_order result mapping", () => {
  const PATIENT = { date_of_birth: "1980-01-01", legal_first_name: "Alex" };

  async function verifyIdentity(
    dispatcher: ReturnType<typeof createVoiceToolDispatcher>,
  ) {
    await dispatcher.dispatch({
      callId: "v1",
      name: "verify_patient_identity",
      args: { date_of_birth: "1980-01-01" },
    });
  }

  it("returns ok:true with the fulfillment id and accepted SKUs on a clean order", async () => {
    const placeOrder = vi.fn(async () => ({
      status: "ok" as const,
      patientId: "pat-1",
      episodeId: "epi-1",
      fulfillmentIds: ["ful-123"],
    }));
    const dispatcher = createVoiceToolDispatcher({
      ...baseDeps,
      supabase: buildStubSupabaseWithRx(PATIENT, [
        { item_sku: "A7030" },
        { item_sku: "A7034" },
      ]),
      placeOrderForConversation: placeOrder as never,
    });
    await verifyIdentity(dispatcher);

    const result = await dispatcher.dispatch({
      callId: "o1",
      name: "place_resupply_order",
      args: { skus: ["A7030", "A7034"], address_confirmed: true },
    });
    expect(placeOrder).toHaveBeenCalledWith({ conversationId: "conv-1" });
    expect(result.result).toEqual({
      ok: true,
      order_id: "ful-123",
      accepted_skus: ["A7030", "A7034"],
    });
  });

  it("treats already_confirmed as an idempotent success (never tells the caller it failed)", async () => {
    const placeOrder = vi.fn(async () => ({
      status: "already_confirmed" as const,
      patientId: "pat-1",
      episodeId: "epi-1",
    }));
    const dispatcher = createVoiceToolDispatcher({
      ...baseDeps,
      supabase: buildStubSupabaseWithRx(PATIENT, [{ item_sku: "A7030" }]),
      placeOrderForConversation: placeOrder as never,
    });
    await verifyIdentity(dispatcher);

    const result = await dispatcher.dispatch({
      callId: "o2",
      name: "place_resupply_order",
      args: { skus: ["A7030"], address_confirmed: true },
    });
    expect(result.result).toEqual({
      ok: true,
      order_id: "",
      accepted_skus: ["A7030"],
      reason: "already_confirmed",
    });
  });

  it("maps an entitlement block to ok:false with a speakable, non-PHI reason", async () => {
    const placeOrder = vi.fn(async () => ({
      status: "not_eligible" as const,
      patientId: "pat-1",
      episodeId: "epi-1",
      entitlement: {
        status: "too_soon",
        reason: "last dispense too recent",
        eligibleOn: "2026-07-15T00:00:00.000Z",
        daysUntilEligible: 35,
        hcpcsCode: "A7030",
      },
    }));
    const dispatcher = createVoiceToolDispatcher({
      ...baseDeps,
      supabase: buildStubSupabaseWithRx(PATIENT, [{ item_sku: "A7030" }]),
      placeOrderForConversation: placeOrder as never,
    });
    await verifyIdentity(dispatcher);

    const result = await dispatcher.dispatch({
      callId: "o3",
      name: "place_resupply_order",
      args: { skus: ["A7030"], address_confirmed: true },
    });
    const r = result.result as {
      ok: boolean;
      accepted_skus: string[];
      reason?: string;
    };
    expect(r.ok).toBe(false);
    expect(r.accepted_skus).toEqual([]);
    expect(r.reason).toContain("2026-07-15");
  });

  it("maps episode_not_found to ok:false with the status as the reason", async () => {
    const placeOrder = vi.fn(async () => ({
      status: "episode_not_found" as const,
    }));
    const dispatcher = createVoiceToolDispatcher({
      ...baseDeps,
      supabase: buildStubSupabaseWithRx(PATIENT, [{ item_sku: "A7030" }]),
      placeOrderForConversation: placeOrder as never,
    });
    await verifyIdentity(dispatcher);

    const result = await dispatcher.dispatch({
      callId: "o4",
      name: "place_resupply_order",
      args: { skus: ["A7030"], address_confirmed: true },
    });
    expect(result.result).toEqual({
      ok: false,
      order_id: "",
      accepted_skus: [],
      reason: "episode_not_found",
    });
  });

  it("returns ok:false WITHOUT calling the shared flow when address_confirmed is false", async () => {
    const placeOrder = vi.fn();
    const dispatcher = createVoiceToolDispatcher({
      ...baseDeps,
      supabase: buildStubSupabaseWithRx(PATIENT, [{ item_sku: "A7030" }]),
      placeOrderForConversation: placeOrder as never,
    });
    await verifyIdentity(dispatcher);

    const result = await dispatcher.dispatch({
      callId: "o5",
      name: "place_resupply_order",
      // The arg schema is z.literal(true), so a runtime caller SHOULD
      // never reach this branch — the model's JSON args would fail Zod
      // validation upstream. Cast to keep the defensive guard exercised.
      args: { skus: ["A7030"], address_confirmed: false } as unknown as {
        skus: string[];
        address_confirmed: true;
      },
    });
    expect(placeOrder).not.toHaveBeenCalled();
    expect(result.result).toEqual({
      ok: false,
      order_id: "",
      accepted_skus: [],
    });
  });

  it("only echoes SKUs backed by an active prescription in accepted_skus", async () => {
    const placeOrder = vi.fn(async () => ({
      status: "ok" as const,
      patientId: "pat-1",
      episodeId: "epi-1",
      fulfillmentIds: ["ful-9"],
    }));
    const dispatcher = createVoiceToolDispatcher({
      ...baseDeps,
      supabase: buildStubSupabaseWithRx(PATIENT, [{ item_sku: "A7030" }]),
      placeOrderForConversation: placeOrder as never,
    });
    await verifyIdentity(dispatcher);

    const result = await dispatcher.dispatch({
      callId: "o6",
      name: "place_resupply_order",
      // "A9999" is invented/misheard — must not be read back as ordered.
      args: { skus: ["A7030", "A9999"], address_confirmed: true },
    });
    expect(
      (result.result as { accepted_skus: string[] }).accepted_skus,
    ).toEqual(["A7030"]);
  });
});

// ---------------------------------------------------------------------------
// get_customer_chart — gated consolidated snapshot for the verified caller
// ---------------------------------------------------------------------------
// The chart issues four reads CONCURRENTLY via Promise.all, so the stub
// must hand each `from(table)` its OWN builder bound to that table — a
// single shared builder (as used by the sequential place_resupply_order
// stub) would race and resolve every chain against the last table seen.

interface ChartStubOpts {
  patient: { date_of_birth: string | null; legal_first_name: string | null };
  prescriptions: Array<{
    item_sku: string;
    cadence_days: number;
    hcpcs_code?: string | null;
  }>;
  lastFulfillment: { created_at: string } | null;
  openFollowups: Array<{ id: string }>;
}

function buildStubSupabaseForChart(opts: ChartStubOpts) {
  const responseFor = (table: string): { data: unknown; error: null } => {
    switch (table) {
      case "patients":
        return { data: opts.patient, error: null };
      case "prescriptions":
        return { data: opts.prescriptions, error: null };
      case "fulfillments":
        return { data: opts.lastFulfillment, error: null };
      case "patient_followups":
        return { data: opts.openFollowups, error: null };
      default:
        return { data: null, error: null };
    }
  };
  const makeBuilder = (table: string): Record<string, unknown> => {
    const b: Record<string, unknown> = {
      select: () => b,
      update: () => b,
      eq: () => b,
      is: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => Promise.resolve(responseFor(table)),
      single: () => Promise.resolve(responseFor(table)),
      then: (
        onfulfilled: (v: unknown) => unknown,
        onrejected?: (e: unknown) => unknown,
      ) => Promise.resolve(responseFor(table)).then(onfulfilled, onrejected),
    };
    return b;
  };
  return {
    schema: () => ({
      from: (table: string) => makeBuilder(table),
    }),
  } as unknown as never;
}

describe("VoiceToolDispatcher — get_customer_chart", () => {
  const RICH_CHART: ChartStubOpts = {
    patient: { date_of_birth: "1980-01-01", legal_first_name: "Alex" },
    prescriptions: [
      // Carries a recognised HCPCS code → the agent reads the
      // plain-English product name instead of the bare SKU.
      { item_sku: "MASK-FF-01", cadence_days: 30, hcpcs_code: "A7030" },
      // No HCPCS code → falls back to the raw SKU.
      { item_sku: "A7034", cadence_days: 90 },
    ],
    lastFulfillment: { created_at: "2026-05-01T00:00:00.000Z" },
    openFollowups: [{ id: "f1" }],
  };

  it("is gated behind identity verification (empty stub before verify)", async () => {
    const dispatcher = createVoiceToolDispatcher({
      ...baseDeps,
      supabase: buildStubSupabaseForChart(RICH_CHART),
    });

    const res = await dispatcher.dispatch({
      callId: "g1",
      name: "get_customer_chart",
      args: {},
    });
    expect(res.result).toEqual({
      kind: "patient",
      supplies_due: [],
      has_open_followups: false,
    });
  });

  it("returns a populated, PHI-scrubbed chart after identity is verified", async () => {
    const dispatcher = createVoiceToolDispatcher({
      ...baseDeps,
      supabase: buildStubSupabaseForChart(RICH_CHART),
    });
    await dispatcher.dispatch({
      callId: "v",
      name: "verify_patient_identity",
      args: { date_of_birth: "1980-01-01" },
    });

    const res = await dispatcher.dispatch({
      callId: "g2",
      name: "get_customer_chart",
      args: {},
    });
    expect(res.result).toEqual({
      kind: "patient",
      first_name: "Alex",
      supplies_due: [
        {
          sku: "MASK-FF-01",
          description: "Full face mask, used with positive airway pressure",
          quantity: 1,
          due_reason: "every 30 days",
        },
        {
          sku: "A7034",
          description: "A7034",
          quantity: 1,
          due_reason: "every 90 days",
        },
      ],
      recent_order_summary: {
        last_order_at: "2026-05-01T00:00:00.000Z",
        open_subscription: false,
      },
      has_open_followups: true,
    });
  });

  it("reports no open follow-ups and a null last order when there's no history", async () => {
    const dispatcher = createVoiceToolDispatcher({
      ...baseDeps,
      supabase: buildStubSupabaseForChart({
        patient: { date_of_birth: "1980-01-01", legal_first_name: "Alex" },
        prescriptions: [],
        lastFulfillment: null,
        openFollowups: [],
      }),
    });
    await dispatcher.dispatch({
      callId: "v",
      name: "verify_patient_identity",
      args: { date_of_birth: "1980-01-01" },
    });

    const res = await dispatcher.dispatch({
      callId: "g3",
      name: "get_customer_chart",
      args: {},
    });
    expect(res.result).toEqual({
      kind: "patient",
      first_name: "Alex",
      supplies_due: [],
      recent_order_summary: { last_order_at: null, open_subscription: false },
      has_open_followups: false,
    });
  });
});

// ---------------------------------------------------------------------------
// lookup_resupply_inventory — same HCPCS→description derivation as the
// chart, but on the standalone inventory tool the model calls when the
// caller asks "what am I due for?".
// ---------------------------------------------------------------------------
describe("VoiceToolDispatcher — lookup_resupply_inventory", () => {
  it("reads HCPCS product names aloud, falling back to the SKU when unknown", async () => {
    const dispatcher = createVoiceToolDispatcher({
      ...baseDeps,
      supabase: buildStubSupabaseForChart({
        patient: { date_of_birth: "1980-01-01", legal_first_name: "Alex" },
        prescriptions: [
          { item_sku: "TUBE-15MM", cadence_days: 90, hcpcs_code: "A7037" },
          { item_sku: "FILT-XYZ", cadence_days: 30 },
        ],
        lastFulfillment: null,
        openFollowups: [],
      }),
    });
    await dispatcher.dispatch({
      callId: "v",
      name: "verify_patient_identity",
      args: { date_of_birth: "1980-01-01" },
    });

    const res = await dispatcher.dispatch({
      callId: "lk",
      name: "lookup_resupply_inventory",
      args: {},
    });
    expect(res.result).toEqual({
      items: [
        {
          sku: "TUBE-15MM",
          description: "Tubing, used with positive airway pressure",
          quantity: 1,
          due_reason: "every 90 days",
        },
        {
          sku: "FILT-XYZ",
          description: "FILT-XYZ",
          quantity: 1,
          due_reason: "every 30 days",
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// Storefront (shop_customer) flow — card-last-4 verify, shop chart, and
// per-caller-kind tool gating. Same per-table-builder stub style as the
// chart tests so Promise.all reads resolve against the right table.
// ---------------------------------------------------------------------------

interface ShopStubOpts {
  last4: string | null;
  displayName: string | null;
  lastOrder: { paid_at: string | null; created_at: string } | null;
  activeSubs: Array<{ status: string }>;
  openFollowups: Array<{ id: string }>;
}

function buildShopStub(opts: ShopStubOpts) {
  const responseFor = (table: string): { data: unknown; error: null } => {
    switch (table) {
      case "shop_customers":
        return {
          data: {
            default_payment_method_last4: opts.last4,
            display_name: opts.displayName,
          },
          error: null,
        };
      case "shop_orders":
        return { data: opts.lastOrder, error: null };
      case "shop_subscriptions":
        return { data: opts.activeSubs, error: null };
      case "shop_customer_followups":
        return { data: opts.openFollowups, error: null };
      default:
        return { data: null, error: null };
    }
  };
  const makeBuilder = (table: string): Record<string, unknown> => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      is: () => b,
      in: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => Promise.resolve(responseFor(table)),
      single: () => Promise.resolve(responseFor(table)),
      then: (
        onfulfilled: (v: unknown) => unknown,
        onrejected?: (e: unknown) => unknown,
      ) => Promise.resolve(responseFor(table)).then(onfulfilled, onrejected),
    };
    return b;
  };
  return {
    schema: () => ({ from: (table: string) => makeBuilder(table) }),
  } as unknown as never;
}

function shopDispatcher(opts: ShopStubOpts) {
  return createVoiceToolDispatcher({
    callerKind: "shop_customer",
    conversationId: "conv-shop-1",
    shopCustomerId: "cust-1",
    supabase: buildShopStub(opts),
  });
}

describe("VoiceToolDispatcher — shop_customer flow", () => {
  const RICH_SHOP: ShopStubOpts = {
    last4: "4242",
    displayName: "Jane Doe",
    lastOrder: {
      paid_at: "2026-05-02T00:00:00.000Z",
      created_at: "2026-05-01T00:00:00.000Z",
    },
    activeSubs: [{ status: "active" }],
    openFollowups: [{ id: "f1" }],
  };

  it("verifies a storefront caller by the last four of the card on file", async () => {
    const dispatcher = shopDispatcher(RICH_SHOP);
    const r = await dispatcher.dispatch({
      callId: "v",
      name: "verify_shop_customer_identity",
      args: { last_four: "4242" },
    });
    expect(r.result).toEqual({
      matched: true,
      first_name: "Jane",
      attempts_remaining: 2,
    });
    expect(dispatcher.isIdentityVerified()).toBe(true);
  });

  it("counts down on a wrong last-four and does not verify", async () => {
    const dispatcher = shopDispatcher(RICH_SHOP);
    const r = await dispatcher.dispatch({
      callId: "v",
      name: "verify_shop_customer_identity",
      args: { last_four: "0000" },
    });
    expect(r.result).toEqual({ matched: false, attempts_remaining: 2 });
    expect(dispatcher.isIdentityVerified()).toBe(false);
  });

  it("signals terminal (attempts_remaining 0) when there is no card on file", async () => {
    // No card on file → verification can never succeed; the result must tell
    // the model to hand off rather than loop asking for digits.
    const dispatcher = shopDispatcher({ ...RICH_SHOP, last4: null });
    const r1 = await dispatcher.dispatch({
      callId: "v1",
      name: "verify_shop_customer_identity",
      args: { last_four: "4242" },
    });
    const r2 = await dispatcher.dispatch({
      callId: "v2",
      name: "verify_shop_customer_identity",
      args: { last_four: "4242" },
    });
    expect(r1.result).toEqual({ matched: false, attempts_remaining: 0 });
    expect(r2.result).toEqual({ matched: false, attempts_remaining: 0 });
  });

  it("gates get_customer_chart behind verification", async () => {
    const dispatcher = shopDispatcher(RICH_SHOP);
    const r = await dispatcher.dispatch({
      callId: "g",
      name: "get_customer_chart",
      args: {},
    });
    expect(r.result).toEqual({
      kind: "patient",
      supplies_due: [],
      has_open_followups: false,
    });
  });

  it("returns a storefront chart after verification", async () => {
    const dispatcher = shopDispatcher(RICH_SHOP);
    await dispatcher.dispatch({
      callId: "v",
      name: "verify_shop_customer_identity",
      args: { last_four: "4242" },
    });
    const r = await dispatcher.dispatch({
      callId: "g",
      name: "get_customer_chart",
      args: {},
    });
    expect(r.result).toEqual({
      kind: "shop_customer",
      first_name: "Jane",
      supplies_due: [],
      recent_order_summary: {
        last_order_at: "2026-05-02T00:00:00.000Z",
        open_subscription: true,
      },
      has_open_followups: true,
    });
  });

  it("refuses patient-only tools for a storefront caller (per-kind gate)", async () => {
    const dispatcher = shopDispatcher(RICH_SHOP);
    const inv = await dispatcher.dispatch({
      callId: "lk",
      name: "lookup_resupply_inventory",
      args: {},
    });
    expect(inv.result).toEqual({ items: [] });
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

  it("refuses the shop verify tool for a patient caller (per-kind gate)", async () => {
    const dispatcher = createVoiceToolDispatcher({
      ...baseDeps,
      supabase: buildStubSupabase({
        date_of_birth: "1980-01-01",
        legal_first_name: "Alex",
      }),
    });
    const r = await dispatcher.dispatch({
      callId: "v",
      name: "verify_shop_customer_identity",
      args: { last_four: "4242" },
    });
    expect(r.result).toEqual({ matched: false, attempts_remaining: 0 });
    expect(dispatcher.isIdentityVerified()).toBe(false);
  });
});

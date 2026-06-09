// Tests for fetchAudienceCandidates — the PR replaced paginated loops with
// single queries for the all_active_*, by_patient_payer audience kinds.
//
// Coverage:
//   1. all_active_shop_customers: single query returns all candidates
//   2. all_active_patients: single query returns active patients
//   3. by_patient_payer: single query filters by payer
//   4. manual_list: still uses batched .in() queries (unchanged)
//   5. Error propagation: supabase error is thrown

import { describe, expect, it } from "vitest";

import { fetchAudienceCandidates } from "./fetch-candidates";

// ── Minimal Supabase fluent-builder mock ────────────────────────────────────
// fetchAudienceCandidates receives a supabase client directly, so we mock it
// by constructing a fluent builder that resolves to staged {data, error}.

type QueryResult = { data: unknown[] | null; error: unknown };

function makeSupabaseMock(result: QueryResult) {
  const builder = {
    schema: (_s: string) => builder,
    from: (_t: string) => builder,
    select: (_cols: string) => builder,
    eq: (_col: string, _val: unknown) => builder,
    order: (_col: string, _opts?: unknown) => builder,
    range: (_from: number, _to: number) => builder,
    in: (_col: string, _vals: unknown[]) => builder,
    then: (resolve: (r: QueryResult) => unknown) =>
      Promise.resolve(resolve(result)),
  };
  return builder as unknown as ReturnType<
    () => ReturnType<
      typeof import("@workspace/resupply-db").getSupabaseServiceRoleClient
    >
  >;
}

// A mock that captures filter calls so we can assert on .eq() usage.
interface Call {
  method: string;
  args: unknown[];
}

function makeCapturingMock(result: QueryResult) {
  const calls: Call[] = [];
  const builder = {
    schema: (_s: string) => builder,
    from: (_t: string) => builder,
    select: (_cols: string) => builder,
    eq: (col: string, val: unknown) => {
      calls.push({ method: "eq", args: [col, val] });
      return builder;
    },
    order: (col: string, opts?: unknown) => {
      calls.push({ method: "order", args: [col, opts] });
      return builder;
    },
    range: (from: number, to: number) => {
      calls.push({ method: "range", args: [from, to] });
      return builder;
    },
    in: (col: string, vals: unknown[]) => {
      calls.push({ method: "in", args: [col, vals] });
      return builder;
    },
    then: (resolve: (r: QueryResult) => unknown) =>
      Promise.resolve(resolve(result)),
  };
  return {
    client: builder as unknown as ReturnType<
      () => ReturnType<
        typeof import("@workspace/resupply-db").getSupabaseServiceRoleClient
      >
    >,
    calls,
  };
}

// ── all_active_shop_customers ────────────────────────────────────────────────

describe("fetchAudienceCandidates — all_active_shop_customers", () => {
  it("returns mapped shop candidates from the single query result", async () => {
    const supabase = makeSupabaseMock({
      data: [
        {
          customer_id: "cust_1",
          email_lower: "alice@example.test",
          communication_preferences: { emailMarketing: true },
        },
        {
          customer_id: "cust_2",
          email_lower: "bob@example.test",
          communication_preferences: null,
        },
      ],
      error: null,
    });

    const result = await fetchAudienceCandidates(supabase, {
      audienceKind: "all_active_shop_customers",
    });

    expect(result.shopCandidates).toHaveLength(2);
    expect(result.shopCandidates[0]).toEqual({
      id: "cust_1",
      emailLower: "alice@example.test",
      communicationPreferences: { emailMarketing: true },
    });
    expect(result.shopCandidates[1]).toEqual({
      id: "cust_2",
      emailLower: "bob@example.test",
      communicationPreferences: null,
    });
    expect(result.patientCandidates).toHaveLength(0);
  });

  it("returns empty shopCandidates when query returns null data", async () => {
    const supabase = makeSupabaseMock({ data: null, error: null });

    const result = await fetchAudienceCandidates(supabase, {
      audienceKind: "all_active_shop_customers",
    });

    expect(result.shopCandidates).toHaveLength(0);
  });

  it("uses .range() and .order() pagination (batched)", async () => {
    const { client, calls } = makeCapturingMock({
      data: [],
      error: null,
    });

    await fetchAudienceCandidates(client, {
      audienceKind: "all_active_shop_customers",
    });

    // Pagination is batched: the query uses .order() + .range().
    expect(calls.some((c) => c.method === "range")).toBe(true);
    expect(calls.some((c) => c.method === "order")).toBe(true);
  });

  it("throws when the query returns an error", async () => {
    const supabase = makeSupabaseMock({
      data: null,
      error: new Error("db error"),
    });

    await expect(
      fetchAudienceCandidates(supabase, {
        audienceKind: "all_active_shop_customers",
      }),
    ).rejects.toThrow("db error");
  });
});

// ── all_active_patients ──────────────────────────────────────────────────────

describe("fetchAudienceCandidates — all_active_patients", () => {
  it("returns mapped patient candidates", async () => {
    const supabase = makeSupabaseMock({
      data: [
        {
          id: "pat_1",
          email: "carol@example.test",
          status: "active",
          insurance_payer: "BCBS",
        },
      ],
      error: null,
    });

    const result = await fetchAudienceCandidates(supabase, {
      audienceKind: "all_active_patients",
    });

    expect(result.patientCandidates).toHaveLength(1);
    expect(result.patientCandidates[0]).toEqual({
      id: "pat_1",
      email: "carol@example.test",
      status: "active",
      insurancePayer: "BCBS",
    });
    expect(result.shopCandidates).toHaveLength(0);
  });

  it("uses .range() pagination (batched)", async () => {
    const { client, calls } = makeCapturingMock({
      data: [],
      error: null,
    });

    await fetchAudienceCandidates(client, {
      audienceKind: "all_active_patients",
    });

    expect(calls.some((c) => c.method === "range")).toBe(true);
  });

  it("throws when the query returns an error", async () => {
    const supabase = makeSupabaseMock({
      data: null,
      error: new Error("patients query failed"),
    });

    await expect(
      fetchAudienceCandidates(supabase, {
        audienceKind: "all_active_patients",
      }),
    ).rejects.toThrow("patients query failed");
  });
});

// ── by_patient_payer ─────────────────────────────────────────────────────────

describe("fetchAudienceCandidates — by_patient_payer", () => {
  it("returns patients filtered by the provided payer", async () => {
    const supabase = makeSupabaseMock({
      data: [
        {
          id: "pat_2",
          email: "dave@example.test",
          status: "active",
          insurance_payer: "Aetna",
        },
      ],
      error: null,
    });

    const result = await fetchAudienceCandidates(supabase, {
      audienceKind: "by_patient_payer",
      audiencePayer: "Aetna",
    });

    expect(result.patientCandidates).toHaveLength(1);
    expect(result.patientCandidates[0]?.insurancePayer).toBe("Aetna");
  });

  it("uses empty-string payer fallback when audiencePayer is null", async () => {
    const { client, calls } = makeCapturingMock({
      data: [],
      error: null,
    });

    await fetchAudienceCandidates(client, {
      audienceKind: "by_patient_payer",
      audiencePayer: null,
    });

    const payerEq = calls.find(
      (c) => c.method === "eq" && c.args[0] === "insurance_payer",
    );
    expect(payerEq).toBeDefined();
    expect(payerEq?.args[1]).toBe("");
  });

  it("uses .range() pagination (batched)", async () => {
    const { client, calls } = makeCapturingMock({
      data: [],
      error: null,
    });

    await fetchAudienceCandidates(client, {
      audienceKind: "by_patient_payer",
      audiencePayer: "UHC",
    });

    expect(calls.some((c) => c.method === "range")).toBe(true);
  });
});

// ── manual_list ──────────────────────────────────────────────────────────────

describe("fetchAudienceCandidates — manual_list", () => {
  it("returns shop candidates from explicit ID list", async () => {
    const supabase = makeSupabaseMock({
      data: [
        {
          customer_id: "cust_manual_1",
          email_lower: "eve@example.test",
          communication_preferences: {},
        },
      ],
      error: null,
    });

    const result = await fetchAudienceCandidates(supabase, {
      audienceKind: "manual_list",
      manualShopCustomerIds: ["cust_manual_1"],
      manualPatientIds: [],
    });

    expect(result.shopCandidates).toHaveLength(1);
    expect(result.shopCandidates[0]?.id).toBe("cust_manual_1");
    expect(result.patientCandidates).toHaveLength(0);
  });

  it("returns empty results when both manual ID lists are empty", async () => {
    // With empty lists, the loop does not execute — no DB call is made.
    // We still expect zero candidates returned.
    const supabase = makeSupabaseMock({ data: [], error: null });

    const result = await fetchAudienceCandidates(supabase, {
      audienceKind: "manual_list",
      manualShopCustomerIds: [],
      manualPatientIds: [],
    });

    expect(result.shopCandidates).toHaveLength(0);
    expect(result.patientCandidates).toHaveLength(0);
  });

  it("returns both shop and patient candidates from separate ID lists", async () => {
    let callCount = 0;
    // First call returns shop customers, second returns patients.
    const builder = {
      schema: (_s: string) => builder,
      from: (_t: string) => builder,
      select: (_cols: string) => builder,
      eq: (_col: string, _val: unknown) => builder,
      in: (_col: string, _vals: unknown[]) => builder,
      order: (_col: string, _opts?: unknown) => builder,
      range: (_from: number, _to: number) => builder,
      then: (resolve: (r: QueryResult) => unknown) => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(
            resolve({
              data: [
                {
                  customer_id: "cust_m",
                  email_lower: "frank@example.test",
                  communication_preferences: null,
                },
              ],
              error: null,
            }),
          );
        }
        return Promise.resolve(
          resolve({
            data: [
              {
                id: "pat_m",
                email: "grace@example.test",
                status: "active",
                insurance_payer: null,
              },
            ],
            error: null,
          }),
        );
      },
    } as unknown as ReturnType<
      () => ReturnType<
        typeof import("@workspace/resupply-db").getSupabaseServiceRoleClient
      >
    >;

    const result = await fetchAudienceCandidates(builder, {
      audienceKind: "manual_list",
      manualShopCustomerIds: ["cust_m"],
      manualPatientIds: ["pat_m"],
    });

    expect(result.shopCandidates).toHaveLength(1);
    expect(result.patientCandidates).toHaveLength(1);
  });
});

// ── by_therapy_cohort (C-R1) ─────────────────────────────────────────────────

describe("fetchAudienceCandidates — by_therapy_cohort", () => {
  // Two-query flow: (1) csr_compliance_alerts for the cohort's patient ids,
  // then (2) patients .in() those ids. callCount switches the staged result.
  function makeCohortMock(opts: {
    capture?: Call[];
    alertRows: Array<{ patient_id: string | null }>;
    patientRows: Array<{
      id: string;
      email: string | null;
      status: string;
      insurance_payer: string | null;
    }>;
  }) {
    let call = 0;
    const builder = {
      schema: (_s: string) => builder,
      from: (_t: string) => builder,
      select: (_cols: string) => builder,
      eq: (col: string, val: unknown) => {
        opts.capture?.push({ method: "eq", args: [col, val] });
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        opts.capture?.push({ method: "in", args: [col, vals] });
        return builder;
      },
      order: (_col: string, _opts?: unknown) => builder,
      range: (_from: number, _to: number) => builder,
      then: (resolve: (r: QueryResult) => unknown) => {
        call++;
        const data = call === 1 ? opts.alertRows : opts.patientRows;
        return Promise.resolve(resolve({ data, error: null }));
      },
    } as unknown as ReturnType<
      () => ReturnType<
        typeof import("@workspace/resupply-db").getSupabaseServiceRoleClient
      >
    >;
    return builder;
  }

  it("resolves the at_risk cohort to its patients via open alerts", async () => {
    const capture: Call[] = [];
    const supabase = makeCohortMock({
      capture,
      // duplicate patient_id across alerts is de-duped before the patient load
      alertRows: [
        { patient_id: "pat_low" },
        { patient_id: "pat_nr" },
        { patient_id: "pat_low" },
      ],
      patientRows: [
        {
          id: "pat_low",
          email: "low@example.test",
          status: "active",
          insurance_payer: "BCBS",
        },
        {
          id: "pat_nr",
          email: "nr@example.test",
          status: "active",
          insurance_payer: null,
        },
      ],
    });

    const result = await fetchAudienceCandidates(supabase, {
      audienceKind: "by_therapy_cohort",
      audiencePayer: "at_risk",
    });

    expect(result.patientCandidates).toHaveLength(2);
    // at_risk targets BOTH low_usage and no_response alert types.
    const alertTypeIn = capture.find(
      (c) => c.method === "in" && c.args[0] === "alert_type",
    );
    expect(alertTypeIn?.args[1]).toEqual(["low_usage", "no_response"]);
    // only OPEN alerts feed the cohort
    expect(
      capture.some((c) => c.method === "eq" && c.args[0] === "status"),
    ).toBe(true);
  });

  it("returns no candidates for an unknown cohort key", async () => {
    const supabase = makeCohortMock({ alertRows: [], patientRows: [] });
    const result = await fetchAudienceCandidates(supabase, {
      audienceKind: "by_therapy_cohort",
      audiencePayer: "not_a_cohort",
    });
    expect(result.patientCandidates).toHaveLength(0);
  });
});

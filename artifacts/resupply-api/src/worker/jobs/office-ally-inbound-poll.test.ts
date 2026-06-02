// Tests for office-ally-inbound-poll.ts — the dispatch835 duplicate guard.
//
// Regression guard for the idempotency bug where dispatch835 found an
// existing era_files row (same SHA-256) but still called reconcileEra,
// re-applying every monetary delta (a double-post of paid / allowed /
// patient-responsibility). The fix short-circuits before reconcileEra,
// mirroring the HTTP era-ingest route's 409-on-duplicate.

import { beforeEach, describe, expect, it } from "vitest";

import {
  getSupabaseCallCount,
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { dispatch835 } from "./office-ally-inbound-poll";

// A minimal but well-formed 835 envelope — enough for parse835() not to
// throw. The duplicate path returns before the parsed body is otherwise used.
const SAMPLE_835 = [
  "ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *250101*1200*^*00501*000000001*0*P*:~",
  "GS*HP*S*R*20250101*1200*1*X*005010X221A1~",
  "ST*835*0001~",
  "BPR*I*100*C*ACH~",
  "SE*3*0001~",
  "GE*1*1~",
  "IEA*1*000000001~",
].join("");

describe("dispatch835 — duplicate 835 idempotency guard", () => {
  beforeEach(() => supabaseMock.reset());

  it("skips re-reconciliation when the same 835 content was already ingested", async () => {
    // An era_files row already exists for this content's SHA-256.
    stageSupabaseResponse("era_files", "select", {
      data: { id: "era-1", status: "processed" },
    });

    const supabase = getSupabaseServiceRoleClient();
    const queued = await dispatch835(
      supabase,
      "inbound-1",
      "PAYMENT.835",
      SAMPLE_835,
    );

    // Returns 0 (nothing newly processed) and — crucially — never re-applies
    // the monetary deltas: no new era_files insert, and reconcileEra (which
    // reads/writes insurance_claims) is never reached.
    expect(queued).toBe(0);
    expect(getSupabaseCallCount("era_files", "insert")).toBe(0);
    expect(getSupabaseCallCount("insurance_claims", "select")).toBe(0);
    expect(getSupabaseCallCount("insurance_claims", "update")).toBe(0);
  });
});

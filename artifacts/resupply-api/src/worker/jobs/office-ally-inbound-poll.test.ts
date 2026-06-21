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

import {
  getOrgScopedClient,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

// The dispatch helpers now take the org-scoped client; wrap the mock
// service-role client through the facade's test seam.
const TEST_ORG_ID = "00000000-0000-0000-0000-000000000001";
const orgClient = () =>
  getOrgScopedClient(TEST_ORG_ID, getSupabaseServiceRoleClient());

import { dispatch277ca, dispatch835 } from "./office-ally-inbound-poll";

// Minimal single-claim 277CA: TRN02 carries the insurance_claims.id, the
// STC category drives the outcome (A2 = accepted, A7 = rejected). One
// claim block with a null submission id keeps the per-submission roll-up
// out of the way so the test asserts only the claim-status transition.
function build277CA(trace: string, stc: string): string {
  return [
    "ISA*00*          *00*          *ZZ*OFFCLY         *ZZ*PENNPAPS01     *260519*1437*^*00501*000000200*0*P*:~",
    "GS*HN*OFFCLY*PENNPAPS01*20260519*1437*200*X*005010X214~",
    "ST*277*0001~",
    "BHT*0085*08*PF-CLAIMS-1*20260519*1437*TH~",
    "HL*1**20*1~",
    "NM1*PR*2*OFFICE ALLY*****46*OFFCLY~",
    "HL*2*1*21*1~",
    "NM1*41*2*PENNPAPS INC*****46*PENNPAPS01~",
    "HL*3*2*19*1~",
    "NM1*85*2*PENNPAPS INC*****XX*1234567893~",
    "HL*4*3*PT~",
    "NM1*QC*1*DOE*JANE****MI*M123456789~",
    `TRN*2*${trace}~`,
    `STC*${stc}*20260519*WQ*249.99~`,
    "REF*1K*PAYER-CLAIM-9988~",
    "SE*14*0001~",
    "GE*1*200~",
    "IEA*1*000000200~",
  ].join("");
}

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

    const supabase = orgClient();
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

  it("re-reconciles (does not skip) when the existing era_files row is 'partial'", async () => {
    // A prior run of this exact 835 left some claim blocks unmatched, so
    // its era_files row is 'partial'. A re-delivery must re-reconcile (the
    // reconciler is per-claim idempotent) instead of short-circuiting —
    // otherwise the now-matchable claims' payments stay stranded.
    stageSupabaseResponse("era_files", "select", {
      data: { id: "era-partial-1", status: "partial" },
    });
    stageSupabaseResponse("era_files", "update", { data: null });
    stageSupabaseResponse("clearinghouse_inbound_files", "update", {
      data: null,
    });

    const queued = await dispatch835(
      orgClient(),
      "inbound-partial",
      "PAYMENT.835",
      SAMPLE_835,
    );

    // Reused the existing partial row (no new insert) AND proceeded past
    // the early-return into reconcile + the status-promotion update.
    expect(getSupabaseCallCount("era_files", "insert")).toBe(0);
    expect(getSupabaseCallCount("era_files", "update")).toBe(1);
    // The minimal 835 carries no claim blocks → no denied claims queued.
    expect(queued).toBe(0);
  });
});

describe("dispatch277ca — reflects the 277CA outcome on the claim status", () => {
  beforeEach(() => supabaseMock.reset());

  function stageClaim(status: string): void {
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: "CLM-X", office_ally_submission_id: null, status },
    });
    stageSupabaseResponse("insurance_claims", "update", {
      data: [{ id: "CLM-X" }],
    });
    stageSupabaseResponse("insurance_claim_events", "insert", {
      data: { id: "evt-1" },
    });
  }

  it("advances a submitted claim to accepted on a 277CA accepted (A2) ack", async () => {
    stageClaim("submitted");
    await dispatch277ca(
      orgClient(),
      "inbound-1",
      build277CA("CLM-X", "A2:20:PR"),
    );
    const [payload] = supabaseMock.writePayloads("insurance_claims", "update");
    expect((payload as { status?: string }).status).toBe("accepted");
  });

  it("moves a submitted claim to rejected on a 277CA rejected (A7) ack", async () => {
    stageClaim("submitted");
    await dispatch277ca(
      orgClient(),
      "inbound-2",
      build277CA("CLM-X", "A7:24:PR"),
    );
    const [payload] = supabaseMock.writePayloads("insurance_claims", "update");
    expect((payload as { status?: string }).status).toBe("rejected");
  });

  it("never downgrades a claim an ERA already resolved (paid stays paid)", async () => {
    stageClaim("paid");
    await dispatch277ca(
      orgClient(),
      "inbound-3",
      build277CA("CLM-X", "A7:24:PR"),
    );
    const [payload] = supabaseMock.writePayloads("insurance_claims", "update");
    // The payer ref may still be captured, but the status must NOT change.
    expect((payload as { status?: string }).status).toBeUndefined();
  });
});

describe("dispatch277ca — submission roll-up", () => {
  beforeEach(() => supabaseMock.reset());

  function stageClaimInSubmission(submissionId: string, status: string): void {
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: "CLM-S", office_ally_submission_id: submissionId, status },
    });
    stageSupabaseResponse("insurance_claims", "update", {
      data: [{ id: "CLM-S" }],
    });
    stageSupabaseResponse("insurance_claim_events", "insert", {
      data: { id: "evt-1" },
    });
    stageSupabaseResponse("office_ally_submissions", "update", { data: null });
    stageSupabaseResponse("clearinghouse_inbound_files", "update", {
      data: null,
    });
  }

  it("does NOT roll a pended (P1) submission up to accepted_277ca — leaves status, still stamps the ack", async () => {
    stageClaimInSubmission("SUB-PENDED", "submitted");
    await dispatch277ca(
      orgClient(),
      "inbound-pended",
      build277CA("CLM-S", "P1:20:PR"),
    );
    const [sub] = supabaseMock.writePayloads(
      "office_ally_submissions",
      "update",
    );
    // The bug: pended used to roll up as accepted_277ca. Now the status is
    // left untouched (no status key) so a later 277CA can resolve it…
    expect(sub).not.toHaveProperty("status");
    // …but the ack receipt is still recorded.
    expect(sub).toHaveProperty("ack_277ca_received_at");
  });

  it("rolls an all-accepted (A2) submission up to accepted_277ca", async () => {
    stageClaimInSubmission("SUB-OK", "submitted");
    await dispatch277ca(
      orgClient(),
      "inbound-acc",
      build277CA("CLM-S", "A2:20:PR"),
    );
    const [sub] = supabaseMock.writePayloads(
      "office_ally_submissions",
      "update",
    );
    expect((sub as { status?: string }).status).toBe("accepted_277ca");
  });

  it("rolls a rejected (A7) submission up to rejected_277ca", async () => {
    stageClaimInSubmission("SUB-REJ", "submitted");
    await dispatch277ca(
      orgClient(),
      "inbound-rej",
      build277CA("CLM-S", "A7:24:PR"),
    );
    const [sub] = supabaseMock.writePayloads(
      "office_ally_submissions",
      "update",
    );
    expect((sub as { status?: string }).status).toBe("rejected_277ca");
  });
});

// Focused test for dispatch277 (the 277 claim-status response ingester).
// Uses the REAL parse277 (pure) + a mocked supabase/webhook so we verify
// the trace→row match + the parsed update end to end.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const publishEvent = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../lib/webhooks/publisher", () => ({ publishEvent }));

import { dispatch277 } from "./office-ally-inbound-poll";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

// trace = `<etin>-<isaCtl>-<stCtl>-<nonce>`; isaCtl is the 2nd segment.
const CONTENT =
  "ISA*00*          *00*          *ZZ*OFFCLY         *ZZ*ETIN           *260601*1330*^*00501*000000009*0*T*:~" +
  "GS*HN*OFFCLY*ETIN*20260601*1330*9*X*005010X212~" +
  "ST*277*0001*005010X212~" +
  "TRN*2*ETIN-000000009-0001-abcd~" +
  "STC*F1:65*20260601*WQ*125*100~" +
  "REF*EJ*CLM-1~REF*1K*PAY-7~" +
  "SE*5*0001~GE*1*9~IEA*1*000000009~";

beforeEach(() => {
  supabaseMock.reset();
  publishEvent.mockClear();
});

describe("dispatch277", () => {
  it("matches the check by ISA control number and stamps the parsed status", async () => {
    stageSupabaseResponse("claim_status_checks", "select", {
      data: { id: "csc_1", claim_id: "clm_1" },
    });
    stageSupabaseResponse("claim_status_checks", "update", { data: null });

    await dispatch277(getSupabaseServiceRoleClient(), "inbound_1", CONTENT);

    const update = supabaseMock.writePayloads(
      "claim_status_checks",
      "update",
    )[0] as Record<string, unknown>;
    expect(update.status).toBe("parsed");
    expect(update.outcome).toBe("finalized_paid");
    expect(update.category_code).toBe("F1");
    expect(update.total_paid_cents).toBe(10000);
    expect(update.applied_to_inbound_file_id).toBe("inbound_1");
    expect(publishEvent).toHaveBeenCalledOnce();
  });

  it("no-ops when no matching check exists", async () => {
    stageSupabaseResponse("claim_status_checks", "select", { data: null });
    await dispatch277(getSupabaseServiceRoleClient(), "inbound_2", CONTENT);
    expect(
      supabaseMock.writePayloads("claim_status_checks", "update"),
    ).toHaveLength(0);
    expect(publishEvent).not.toHaveBeenCalled();
  });
});

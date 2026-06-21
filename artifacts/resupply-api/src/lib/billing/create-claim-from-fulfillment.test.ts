// Unit tests for the shared createClaimFromFulfillment core. The claim
// BUILDER is mocked (its DB walk is exercised elsewhere); these tests pin the
// persist/duplicate-guard/result-shape contract that both the single route and
// the batch route depend on.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

// Keep the pure buildClaimLineRows real; stub only the DB-walking builder.
vi.mock("./claim-builder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./claim-builder")>();
  return { ...actual, buildClaimFromFulfillment: vi.fn() };
});

vi.mock("./bill-hold", () => ({
  seedDefaultRequirementsForClaim: vi.fn(async () => ({
    created: 0,
    held: false,
  })),
}));

import { buildClaimFromFulfillment, type ProposedClaim } from "./claim-builder";
import { seedDefaultRequirementsForClaim } from "./bill-hold";
import { createClaimFromFulfillment } from "./create-claim-from-fulfillment";

const ORG = "00000000-0000-4000-8000-000000000000";
const FID = "11111111-1111-4111-8111-111111111111";
const CLAIM_ID = "22222222-2222-4222-8222-222222222222";

const buildMock = vi.mocked(buildClaimFromFulfillment);
const seedMock = vi.mocked(seedDefaultRequirementsForClaim);

function proposedFixture(
  overrides: Partial<ProposedClaim> = {},
): ProposedClaim {
  return {
    patientId: "p-1",
    payerProfileId: "pp-1",
    payerName: "Medicare",
    insuranceCoverageId: "cov-1",
    secondaryCoverageId: null,
    dateOfService: "2026-06-01",
    fulfillmentId: FID,
    diagnosisCodes: ["G47.33"],
    referringProviderId: "prov-1",
    renderingProviderId: null,
    priorAuthNumber: null,
    lines: [
      {
        hcpcsCode: "A7034",
        modifiers: ["KX"],
        description: "Nasal mask",
        quantity: 1,
        billedCents: 9900,
        sourceKind: "product_map",
        sourceRef: "map-1",
        feeScheduleRowId: null,
      },
    ],
    builderNotes: [],
    ...overrides,
  };
}

beforeEach(() => {
  supabaseMock.reset();
  buildMock.mockReset();
  seedMock.mockReset();
  seedMock.mockResolvedValue({ created: 0, held: false });
});

describe("createClaimFromFulfillment", () => {
  it("creates a draft claim + lines + event and returns 'created'", async () => {
    buildMock.mockResolvedValue(proposedFixture());
    stageSupabaseResponse("insurance_claims", "select", { data: null }); // dup guard
    stageSupabaseResponse("insurance_claims", "insert", {
      data: { id: CLAIM_ID },
    });
    stageSupabaseResponse("insurance_claim_line_items", "insert", {
      data: null,
    });
    stageSupabaseResponse("insurance_claim_events", "insert", { data: null });

    const result = await createClaimFromFulfillment({
      fulfillmentId: FID,
      orgId: ORG,
      actorEmail: "biller@penn.example.com",
      actorUserId: "u-1",
      billHoldEnabled: false,
    });

    expect(result.status).toBe("created");
    if (result.status === "created") {
      expect(result.claimId).toBe(CLAIM_ID);
      expect(result.lineCount).toBe(1);
    }
    // Header carries the summed billed total + draft status.
    const header = supabaseMock.writePayloads(
      "insurance_claims",
      "insert",
    )[0] as Record<string, unknown> | undefined;
    expect(header?.status).toBe("draft");
    expect(header?.total_billed_cents).toBe(9900);
    // bill-hold disabled → no seed.
    expect(seedMock).not.toHaveBeenCalled();
  });

  it("returns 'claim_exists' when an open claim already covers the fulfillment", async () => {
    buildMock.mockResolvedValue(proposedFixture());
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, status: "submitted" },
    });

    const result = await createClaimFromFulfillment({
      fulfillmentId: FID,
      orgId: ORG,
      actorEmail: null,
      actorUserId: null,
      billHoldEnabled: false,
    });

    expect(result.status).toBe("claim_exists");
    if (result.status === "claim_exists") {
      expect(result.claimId).toBe(CLAIM_ID);
      expect(result.existingStatus).toBe("submitted");
    }
    // No insert attempted.
    expect(supabaseMock.callCount("insurance_claims", "insert")).toBe(0);
  });

  it("returns 'fulfillment_not_found' when the builder reports the row is missing", async () => {
    buildMock.mockRejectedValue(
      new Error(`buildClaimFromFulfillment: fulfillment ${FID} not found`),
    );

    const result = await createClaimFromFulfillment({
      fulfillmentId: FID,
      orgId: ORG,
      actorEmail: null,
      actorUserId: null,
      billHoldEnabled: false,
    });

    expect(result.status).toBe("fulfillment_not_found");
  });

  it("seeds the signed-paperwork hold set when billHoldEnabled is true", async () => {
    buildMock.mockResolvedValue(proposedFixture());
    stageSupabaseResponse("insurance_claims", "select", { data: null });
    stageSupabaseResponse("insurance_claims", "insert", {
      data: { id: CLAIM_ID },
    });
    stageSupabaseResponse("insurance_claim_line_items", "insert", {
      data: null,
    });
    stageSupabaseResponse("insurance_claim_events", "insert", { data: null });

    const result = await createClaimFromFulfillment({
      fulfillmentId: FID,
      orgId: ORG,
      actorEmail: "biller@penn.example.com",
      actorUserId: "u-1",
      billHoldEnabled: true,
    });

    expect(result.status).toBe("created");
    expect(seedMock).toHaveBeenCalledTimes(1);
    expect(seedMock.mock.calls[0]?.[0]).toBe(CLAIM_ID);
  });

  it("propagates an unexpected DB error (so callers can isolate/500)", async () => {
    buildMock.mockResolvedValue(proposedFixture());
    stageSupabaseResponse("insurance_claims", "select", { data: null });
    stageSupabaseResponse("insurance_claims", "insert", {
      error: { code: "08006", message: "connection terminated" },
    });

    await expect(
      createClaimFromFulfillment({
        fulfillmentId: FID,
        orgId: ORG,
        actorEmail: null,
        actorUserId: null,
        billHoldEnabled: false,
      }),
    ).rejects.toMatchObject({ code: "08006" });
  });
});

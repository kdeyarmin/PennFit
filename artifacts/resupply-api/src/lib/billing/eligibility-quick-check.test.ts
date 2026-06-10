// Tests for the patient-less quick eligibility check.
//
// The 270 build + real-time transport live in
// @workspace/resupply-integrations-office-ally and have their own
// suites. Here we lock down the quick-check contract:
//
//   * PayerProfileNotFoundError when the payer profile id is unknown
//   * Throws "payer does not accept electronic 270/271" when the payer
//     is paper-only or has no office_ally_payer_id
//   * Reports `unavailable` (no throw, no transmit) when real-time
//     eligibility is not configured — there is NO SFTP fallback
//   * Happy path returns the parsed benefits + payer name + latency
//   * NOTHING is persisted: no eligibility_checks insert on success,
//     on transport failure, or on the unavailable path

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const PARSED_271 = {
  traceReference: "TRACE-1",
  isActive: true,
  inNetwork: true,
  deductibleCents: 50000,
  deductibleMetCents: 10000,
  deductibleRemainingCents: 40000,
  oopMaxCents: 200000,
  oopMetCents: 25000,
  oopRemainingCents: 175000,
  copayCents: null,
  coinsurancePct: 20,
  requiresPriorAuth: false,
  messages: ["CPAP SUPPLIES COVERED"],
};

vi.mock("@workspace/resupply-integrations-office-ally", () => ({
  allocateControlNumbers: vi.fn(() => ({})),
  build270: vi.fn(() => ({
    payload: "ISA*...",
    interchangeControlNumber: "000000001",
    groupControlNumber: "1",
    traceReference: "TRACE-1",
  })),
  parse271: vi.fn(() => PARSED_271),
  createRealtimeEligibilityTransport: vi.fn(() => ({
    kind: "https",
    requestEligibility: vi.fn(async () => ({
      ok: true,
      payload271: "ISA*...271~",
      sessionId: "S1",
    })),
  })),
}));

// Stub identity-resolver so we don't depend on its DB reads.
vi.mock("./identity-resolver", () => ({
  resolveBillingIdentity: vi.fn(async () => ({
    source: "stub",
    organization: null,
    billingProvider: { organizationName: "X", npi: "1234567890" },
    submitter: { etin: "X", organizationName: "X", contactName: "B" },
    usageIndicator: "T",
  })),
  resolveClearinghouse: vi.fn(async () => ({
    source: "stub",
    config: null,
    row: null,
    realtimeConfig: null,
    usageIndicator: "T",
    submitter: { etin: "X", organizationName: "X", contactName: "B" },
  })),
}));

import {
  build270,
  createRealtimeEligibilityTransport,
} from "@workspace/resupply-integrations-office-ally";

import {
  PayerProfileNotFoundError,
  quickCheckEligibility,
} from "./eligibility-quick-check";
import { resolveClearinghouse } from "./identity-resolver";

type ResolvedClearinghouseMock = Awaited<
  ReturnType<typeof resolveClearinghouse>
>;
const REALTIME_RESOLVED = {
  source: "db",
  config: null,
  row: null,
  realtimeConfig: {
    url: "https://edi.officeally.io/v2/eligibility-benefits/x12",
    apiKey: "test-api-key",
    timeoutMs: 5000,
  },
  usageIndicator: "T",
  submitter: {
    etin: "ETIN",
    organizationName: "X",
    contactName: "B",
    contactPhoneE164: "+10000000000",
  },
} as unknown as ResolvedClearinghouseMock;

const PAYER_PROFILE_ID = "44444444-4444-4444-8444-444444444444";

const SUBSCRIBER = {
  firstName: "Alice",
  lastName: "Walkin",
  memberId: "MEM-99",
  dateOfBirth: "1965-04-12",
} as const;

function stageElectronicPayer(): void {
  stageSupabaseResponse("payer_profiles", "select", {
    data: {
      id: PAYER_PROFILE_ID,
      display_name: "Acme Health",
      payer_legal_name: "ACME HEALTH PLANS INC",
      office_ally_payer_id: "OA123",
      paper_only: false,
    },
  });
}

beforeEach(() => supabaseMock.reset());

describe("quickCheckEligibility — payer gates", () => {
  it("throws PayerProfileNotFoundError when the payer id is unknown", async () => {
    stageSupabaseResponse("payer_profiles", "select", { data: null });
    await expect(
      quickCheckEligibility({
        payerProfileId: PAYER_PROFILE_ID,
        subscriber: SUBSCRIBER,
      }),
    ).rejects.toBeInstanceOf(PayerProfileNotFoundError);
  });

  it("throws when the payer is paper-only or lacks an OA payer id", async () => {
    stageSupabaseResponse("payer_profiles", "select", {
      data: {
        id: PAYER_PROFILE_ID,
        display_name: "Paper Payer",
        payer_legal_name: "PAPER PAYER",
        office_ally_payer_id: null,
        paper_only: true,
      },
    });
    await expect(
      quickCheckEligibility({
        payerProfileId: PAYER_PROFILE_ID,
        subscriber: SUBSCRIBER,
      }),
    ).rejects.toThrow(/does not accept electronic 270/);
  });
});

describe("quickCheckEligibility — real-time only, no persistence", () => {
  it("reports unavailable (without transmitting) when real-time is unconfigured", async () => {
    stageElectronicPayer();

    const result = await quickCheckEligibility({
      payerProfileId: PAYER_PROFILE_ID,
      subscriber: SUBSCRIBER,
    });

    expect(result.status).toBe("unavailable");
    expect(
      vi.mocked(createRealtimeEligibilityTransport),
    ).not.toHaveBeenCalled();
    expect(supabaseMock.writePayloads("eligibility_checks", "insert")).toEqual(
      [],
    );
  });

  it("returns the parsed benefits inline and persists nothing", async () => {
    stageElectronicPayer();
    vi.mocked(resolveClearinghouse).mockResolvedValueOnce(REALTIME_RESOLVED);

    const result = await quickCheckEligibility({
      payerProfileId: PAYER_PROFILE_ID,
      subscriber: SUBSCRIBER,
      hcpcsCode: "E0601",
    });

    expect(result.status).toBe("parsed");
    if (result.status !== "parsed") throw new Error("unreachable");
    expect(result.payerName).toBe("Acme Health");
    expect(result.traceReference).toBe("TRACE-1");
    expect(typeof result.latencyMs).toBe("number");
    expect(result.benefits.isActive).toBe(true);
    expect(result.benefits.deductibleCents).toBe(50000);
    expect(result.benefits.coinsurancePct).toBe(20);
    expect(result.benefits.messages).toEqual(["CPAP SUPPLIES COVERED"]);

    // The whole point: nothing was written anywhere.
    expect(supabaseMock.writePayloads("eligibility_checks", "insert")).toEqual(
      [],
    );
    expect(supabaseMock.writePayloads("patients", "insert")).toEqual([]);
    expect(supabaseMock.writePayloads("insurance_coverages", "insert")).toEqual(
      [],
    );
  });

  it("passes the typed subscriber + HCPCS through to build270", async () => {
    stageElectronicPayer();
    vi.mocked(resolveClearinghouse).mockResolvedValueOnce(REALTIME_RESOLVED);

    await quickCheckEligibility({
      payerProfileId: PAYER_PROFILE_ID,
      subscriber: { ...SUBSCRIBER, gender: "F" },
      hcpcsCode: "E0601",
    });

    const buildInput = vi.mocked(build270).mock.calls.at(-1)?.[0];
    expect(buildInput?.subscriber).toMatchObject({
      firstName: "Alice",
      lastName: "Walkin",
      memberId: "MEM-99",
      dateOfBirth: "1965-04-12",
      gender: "F",
    });
    expect(buildInput?.serviceTypeCode).toBe("12");
    expect(buildInput?.hcpcsCode).toBe("E0601");
    expect(buildInput?.payer).toMatchObject({
      organizationName: "ACME HEALTH PLANS INC",
      payerId: "OA123",
    });
  });

  it("surfaces a transport failure as status=failed with no fallback writes", async () => {
    stageElectronicPayer();
    vi.mocked(resolveClearinghouse).mockResolvedValueOnce(REALTIME_RESOLVED);
    vi.mocked(createRealtimeEligibilityTransport).mockReturnValueOnce({
      kind: "https",
      requestEligibility: vi.fn(async () => ({
        ok: false,
        kind: "connect_failed",
        message: "real-time request failed to connect",
      })),
    } as unknown as ReturnType<typeof createRealtimeEligibilityTransport>);

    const result = await quickCheckEligibility({
      payerProfileId: PAYER_PROFILE_ID,
      subscriber: SUBSCRIBER,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.message).toMatch(/failed to connect/);
    expect(supabaseMock.writePayloads("eligibility_checks", "insert")).toEqual(
      [],
    );
  });
});

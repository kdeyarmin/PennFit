// Tests for the patient-less insurance discovery lib.
//
// The discovery transport lives in
// @workspace/resupply-integrations-office-ally and has its own suite. Here
// we lock down the lib contract:
//
//   * Reports `unavailable` (no transport, no metering) when discovery
//     isn't configured for the tenant
//   * Happy path returns the matched coverages + active count + latency
//     and meters ONE billing transaction
//   * An empty match set reports `none`
//   * A transport failure surfaces as `failed`

import { describe, it, expect, vi, beforeEach } from "vitest";

const discoverMock = vi.fn();
vi.mock("@workspace/resupply-integrations-office-ally", () => ({
  createInsuranceDiscoveryTransport: vi.fn(() => ({
    kind: "https",
    discover: discoverMock,
  })),
}));

vi.mock("./identity-resolver", () => ({
  resolveClearinghouse: vi.fn(async () => ({ discoveryConfig: null })),
}));

vi.mock("../metering/usage", () => ({
  recordTenantUsage: vi.fn(async () => {}),
}));

import {
  createInsuranceDiscoveryTransport,
  type DiscoveredCoverage,
} from "@workspace/resupply-integrations-office-ally";
import { recordTenantUsage } from "../metering/usage";

import { runInsuranceDiscovery } from "./insurance-discovery";
import { resolveClearinghouse } from "./identity-resolver";

const SUBSCRIBER = {
  firstName: "Alice",
  lastName: "Walkin",
  dateOfBirth: "1965-04-12",
} as const;

const DISCOVERY_CONFIG = {
  url: "https://edi.officeally.io/v2/insurance-discovery",
  apiKey: "k",
  timeoutMs: 5000,
};

const COVERAGE: DiscoveredCoverage = {
  payerName: "Acme Health",
  payerId: "OA123",
  memberId: "MEM-1",
  planName: "PPO",
  isActive: true,
  coverageStart: "2026-01-01",
  coverageEnd: null,
};

function withDiscoveryConfigured(): void {
  vi.mocked(resolveClearinghouse).mockResolvedValueOnce({
    discoveryConfig: DISCOVERY_CONFIG,
  } as unknown as Awaited<ReturnType<typeof resolveClearinghouse>>);
}

beforeEach(() => {
  vi.mocked(recordTenantUsage).mockClear();
  vi.mocked(createInsuranceDiscoveryTransport).mockClear();
  discoverMock.mockReset();
});

describe("runInsuranceDiscovery", () => {
  it("reports unavailable (no transport, no metering) when not configured", async () => {
    const result = await runInsuranceDiscovery({
      subscriber: SUBSCRIBER,
      orgId: "org-1",
    });
    expect(result.status).toBe("unavailable");
    expect(vi.mocked(createInsuranceDiscoveryTransport)).not.toHaveBeenCalled();
    expect(vi.mocked(recordTenantUsage)).not.toHaveBeenCalled();
  });

  it("returns matched coverages + active count and meters one transaction", async () => {
    withDiscoveryConfigured();
    discoverMock.mockResolvedValueOnce({
      ok: true,
      coverages: [COVERAGE, { ...COVERAGE, isActive: false }],
      sessionId: "S1",
    });

    const result = await runInsuranceDiscovery({
      subscriber: { ...SUBSCRIBER, gender: "F" },
      orgId: "org-1",
    });

    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("unreachable");
    expect(result.coverages).toHaveLength(2);
    expect(result.activeCount).toBe(1);
    expect(typeof result.latencyMs).toBe("number");

    expect(vi.mocked(recordTenantUsage)).toHaveBeenCalledWith(
      expect.objectContaining({
        metricKey: "billingTransactionsPerMonth",
        source: "insurance.discovery",
      }),
    );
  });

  it("reports none when the search matched nothing", async () => {
    withDiscoveryConfigured();
    discoverMock.mockResolvedValueOnce({
      ok: true,
      coverages: [],
      sessionId: "S1",
    });
    const result = await runInsuranceDiscovery({
      subscriber: SUBSCRIBER,
      orgId: "org-1",
    });
    expect(result.status).toBe("none");
    // The round-trip still happened → still metered.
    expect(vi.mocked(recordTenantUsage)).toHaveBeenCalledTimes(1);
  });

  it("surfaces a transport failure as status=failed", async () => {
    withDiscoveryConfigured();
    discoverMock.mockResolvedValueOnce({
      ok: false,
      kind: "connect_failed",
      message: "insurance discovery request failed to connect",
    });
    const result = await runInsuranceDiscovery({
      subscriber: SUBSCRIBER,
      orgId: "org-1",
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.message).toMatch(/failed to connect/);
    // A transport failure never reached Office Ally's billing layer, so it
    // must NOT be metered as a billable transaction.
    expect(vi.mocked(recordTenantUsage)).not.toHaveBeenCalled();
  });
});

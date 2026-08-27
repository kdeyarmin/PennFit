// Unit tests for resolveProviderTenantOrgId — brand host vs session pin.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const PROVIDER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const resolveBrandOrgIdByHostMock = vi.hoisted(() =>
  vi.fn(async (_host: string): Promise<string | null> => null),
);
vi.mock("../../lib/tenant-branding", () => ({
  resolveBrandOrgIdByHost: resolveBrandOrgIdByHostMock,
}));

const findSessionByIdMock = vi.hoisted(() =>
  vi.fn(async (_id: string) => ({
    providerActiveOrgId: null as string | null,
  })),
);
const setProviderActiveOrgIdMock = vi.hoisted(() =>
  vi.fn(async (_id: string, _orgId: string | null) => undefined),
);
vi.mock("../../lib/auth-deps", () => ({
  getAuthDeps: () => ({
    repo: {
      findSessionById: findSessionByIdMock,
      setProviderActiveOrgId: setProviderActiveOrgIdMock,
    },
  }),
}));

import { resolveProviderTenantOrgId } from "./shared";

beforeEach(() => {
  supabaseMock.reset();
  resolveBrandOrgIdByHostMock.mockReset();
  resolveBrandOrgIdByHostMock.mockResolvedValue(null);
  findSessionByIdMock.mockReset();
  findSessionByIdMock.mockResolvedValue({ providerActiveOrgId: null });
  setProviderActiveOrgIdMock.mockReset();
});

describe("resolveProviderTenantOrgId", () => {
  it("returns the brand-host org and ignores the session pin", async () => {
    resolveBrandOrgIdByHostMock.mockResolvedValueOnce(ORG_A);
    findSessionByIdMock.mockResolvedValue({ providerActiveOrgId: ORG_B });

    const orgId = await resolveProviderTenantOrgId({
      headers: { host: "pennpaps.example" },
      authSessionId: SESSION_ID,
      providerAccount: {
        id: "acct",
        providerId: PROVIDER_ID,
        emailLower: "dr@example.com",
        status: "active",
        mfaEnrolledAt: null,
      },
    });

    expect(orgId).toBe(ORG_A);
    expect(findSessionByIdMock).not.toHaveBeenCalled();
  });

  it("uses a membership-validated session pin on the platform host", async () => {
    findSessionByIdMock.mockResolvedValue({ providerActiveOrgId: ORG_A });
    stageSupabaseResponse("provider_dme_links", "select", {
      data: { id: "link-1" },
    });

    const orgId = await resolveProviderTenantOrgId({
      headers: { host: "cmbreathe.example" },
      authSessionId: SESSION_ID,
      providerAccount: {
        id: "acct",
        providerId: PROVIDER_ID,
        emailLower: "dr@example.com",
        status: "active",
        mfaEnrolledAt: null,
      },
    });

    expect(orgId).toBe(ORG_A);
  });

  it("clears a stale pin and returns null when membership is gone", async () => {
    findSessionByIdMock.mockResolvedValue({ providerActiveOrgId: ORG_A });
    stageSupabaseResponse("provider_dme_links", "select", { data: null });

    const orgId = await resolveProviderTenantOrgId({
      headers: { host: "cmbreathe.example" },
      authSessionId: SESSION_ID,
      providerAccount: {
        id: "acct",
        providerId: PROVIDER_ID,
        emailLower: "dr@example.com",
        status: "active",
        mfaEnrolledAt: null,
      },
    });

    expect(orgId).toBeNull();
    expect(setProviderActiveOrgIdMock).toHaveBeenCalledWith(SESSION_ID, null);
  });

  it("returns null on the platform host with no pin (never seed fallback)", async () => {
    const orgId = await resolveProviderTenantOrgId({
      headers: { host: "cmbreathe.example" },
      authSessionId: SESSION_ID,
      providerAccount: {
        id: "acct",
        providerId: PROVIDER_ID,
        emailLower: "dr@example.com",
        status: "active",
        mfaEnrolledAt: null,
      },
    });
    expect(orgId).toBeNull();
  });
});

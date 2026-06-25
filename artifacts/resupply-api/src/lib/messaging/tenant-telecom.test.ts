// Per-tenant Twilio sending identity resolver (G7).

import { beforeEach, describe, expect, it, vi } from "vitest";

const SEED_ORG = "00000000-0000-4000-8000-000000000000";

const { state } = vi.hoisted(() => ({
  state: {
    responses: [] as Array<{ data: unknown; error: unknown }>,
    calls: 0,
  },
}));

vi.mock("@workspace/resupply-db", () => {
  const terminal = () => ({
    limit: () => ({
      maybeSingle: async () => {
        state.calls += 1;
        return state.responses.shift() ?? { data: null, error: null };
      },
    }),
  });
  return {
    resolveSeedOrgId: async () => SEED_ORG,
    getOrgScopedClient: () => ({
      raw: () => ({
        schema: () => ({
          from: () => ({
            // outbound (loadTelecomRow): .select().eq().limit().maybeSingle()
            // inbound (reverse): .select().or().limit().maybeSingle()
            select: () => ({ eq: terminal, or: terminal }),
          }),
        }),
      }),
    }),
  };
});

import {
  invalidateTenantTelecomCache,
  resolveOrgIdByCalledNumber,
  resolveTenantSmsFrom,
  resolveTenantVoiceFrom,
} from "./tenant-telecom";

const ORG = "11111111-1111-4111-8111-111111111111";

function row(over: Record<string, string | null> = {}) {
  return {
    data: {
      sms_from_number: null,
      voice_from_number: null,
      twilio_messaging_service_sid: null,
      ...over,
    },
    error: null,
  };
}

beforeEach(() => {
  state.responses = [];
  state.calls = 0;
  invalidateTenantTelecomCache();
});

describe("resolveTenantSmsFrom", () => {
  it("returns {} for an undefined / blank orgId without querying", async () => {
    expect(await resolveTenantSmsFrom(undefined)).toEqual({});
    expect(await resolveTenantSmsFrom("   ")).toEqual({});
    expect(state.calls).toBe(0);
  });

  it("returns the tenant's from-number when set", async () => {
    state.responses = [row({ sms_from_number: "+15551234567" })];
    expect(await resolveTenantSmsFrom(ORG)).toEqual({ from: "+15551234567" });
  });

  it("returns the messaging service SID when set", async () => {
    state.responses = [row({ twilio_messaging_service_sid: "MG0123456789" })];
    expect(await resolveTenantSmsFrom(ORG)).toEqual({
      messagingServiceSid: "MG0123456789",
    });
  });

  it("returns {} (platform default) when the tenant has no SMS sender", async () => {
    state.responses = [row()];
    expect(await resolveTenantSmsFrom(ORG)).toEqual({});
  });

  it("fails soft to {} on a lookup error", async () => {
    state.responses = [{ data: null, error: { message: "boom" } }];
    expect(await resolveTenantSmsFrom(ORG)).toEqual({});
  });

  it("caches the row (no second query within the TTL)", async () => {
    state.responses = [row({ sms_from_number: "+15551234567" })];
    await resolveTenantSmsFrom(ORG);
    await resolveTenantSmsFrom(ORG);
    expect(state.calls).toBe(1);
  });
});

describe("resolveTenantVoiceFrom", () => {
  it("returns the voice caller-id when set", async () => {
    state.responses = [row({ voice_from_number: "+15559998888" })];
    expect(await resolveTenantVoiceFrom(ORG)).toBe("+15559998888");
  });

  it("returns null (platform default) when unset", async () => {
    state.responses = [row()];
    expect(await resolveTenantVoiceFrom(ORG)).toBeNull();
  });

  it("returns null for an undefined orgId without querying", async () => {
    expect(await resolveTenantVoiceFrom(undefined)).toBeNull();
    expect(state.calls).toBe(0);
  });
});

describe("resolveOrgIdByCalledNumber", () => {
  it("reverse-maps a called number to its owning org", async () => {
    state.responses = [{ data: { id: ORG }, error: null }];
    expect(await resolveOrgIdByCalledNumber("+15551234567")).toBe(ORG);
  });

  it("returns null for an unknown number", async () => {
    state.responses = [
      { data: null, error: null },
      { data: null, error: null },
    ];
    expect(await resolveOrgIdByCalledNumber("+15550000000")).toBeNull();
  });

  it("returns null for a blank number without querying", async () => {
    expect(await resolveOrgIdByCalledNumber("  ")).toBeNull();
    expect(state.calls).toBe(0);
  });

  it("normalizes a NANP-format called number to E.164 before the lookup", async () => {
    state.responses = [{ data: { id: ORG }, error: null }];
    // 10-digit NANP → +1... ; the resolver normalizes before querying.
    expect(await resolveOrgIdByCalledNumber("(555) 123-4567")).toBe(ORG);
  });

  it("rejects a To carrying PostgREST filter metacharacters (no cross-tenant query)", async () => {
    // A `To` value with commas/dots that, if interpolated raw into the old
    // `.or()` filter, could have added an OR condition matching another
    // tenant's id. normalizeE164 rejects it (not E.164), so no query runs and
    // it can never resolve to a foreign org_id.
    state.responses = [
      { data: { id: "22222222-2222-4222-8222-222222222222" }, error: null },
    ];
    expect(
      await resolveOrgIdByCalledNumber(
        "x,id.eq.22222222-2222-4222-8222-222222222222",
      ),
    ).toBeNull();
    expect(state.calls).toBe(0);
  });
});

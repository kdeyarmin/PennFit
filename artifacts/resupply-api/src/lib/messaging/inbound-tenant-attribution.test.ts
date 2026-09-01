// Inbound tenant attribution — which practice does this call belong to?
//
// WHY THIS SUITE EXISTS SEPARATELY
// --------------------------------
// `tenant-telecom.test.ts` covers the resolver's mechanics. This covers
// the multi-tenant SCENARIOS the mechanics exist for, because the ways
// this goes wrong are not unit-shaped:
//
//   * Two tenants, two DIDs. An inbound call must reach the tenant that
//     owns the number it was dialled on, and nothing else.
//   * The SAME number registered for SMS by one tenant and for VOICE by
//     another. The partial unique indexes are PER COLUMN, so nothing in
//     the database prevents it. A channel-blind lookup resolved a voice
//     call to the SMS owner, silently, and every downstream read was
//     scoped to the wrong practice.
//   * A caller whose phone number exists in two tenants. Tie-breaking on
//     recency is a coin flip dressed as a heuristic — recency of contact
//     is not evidence of ownership — and the loser's patient gets the
//     winner's conversation thread and any PHI in it.
//
// Production had no real `voice_calls` rows when this attribution was
// last reviewed, so nothing had ever exercised it against live data.
// These are deterministic and need no telephone.
//
// PHI: fixtures use synthetic numbers in the +1555 test range.

import { beforeEach, describe, expect, it, vi } from "vitest";

const SEED_ORG = "00000000-0000-4000-8000-000000000000";
const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

const DID_A = "+15550001111";
const DID_B = "+15550002222";
/** One DID, registered by A for SMS and by B for voice. */
const SHARED_DID = "+15550009999";
/** A phone number two tenants both have a patient for. */
const SHARED_PATIENT_PHONE = "+15550007777";

interface OrgRow {
  id: string;
  sms_from_number: string | null;
  voice_from_number: string | null;
}

interface PatientRow {
  id: string;
  org_id: string;
  phone_e164: string;
}

const { store } = vi.hoisted(() => ({
  store: {
    orgs: [] as OrgRow[],
    patients: [] as PatientRow[],
    /** Every filter the resolver applied, so a channel-blind probe is visible. */
    probes: [] as Array<{ table: string; column: string; value: unknown }>,
    fail: false,
  },
}));

/**
 * A PostgREST-shaped fake over the two GLOBAL directory tables the
 * resolver reads. Filters actually filter — a fake that ignored them
 * could not tell a channel-blind lookup from a correct one, which is the
 * whole subject here.
 */
vi.mock("@workspace/resupply-db", () => {
  function builder(table: "organizations" | "patients") {
    let rows: Array<Record<string, unknown>> =
      table === "organizations"
        ? (store.orgs as unknown as Array<Record<string, unknown>>)
        : (store.patients as unknown as Array<Record<string, unknown>>);
    const self = {
      select: () => self,
      eq: (column: string, value: unknown) => {
        store.probes.push({ table, column, value });
        rows = rows.filter((r) => r[column] === value);
        return self;
      },
      not: (column: string, _op: string, _value: null) => {
        rows = rows.filter(
          (r) => r[column] !== null && r[column] !== undefined,
        );
        return self;
      },
      or: () => self,
      limit: (n: number) => {
        rows = rows.slice(0, n);
        return self;
      },
      maybeSingle: async () =>
        store.fail
          ? { data: null, error: { message: "postgrest down" } }
          : { data: rows[0] ?? null, error: null },
      then: (resolve: (v: { data: unknown; error: unknown }) => void): void => {
        resolve(
          store.fail
            ? { data: null, error: { message: "postgrest down" } }
            : { data: rows, error: null },
        );
      },
    };
    return self;
  }

  return {
    resolveSeedOrgId: async () => SEED_ORG,
    getOrgScopedClient: () => ({
      raw: () => ({
        schema: () => ({
          from: (table: string) =>
            builder(table as "organizations" | "patients"),
        }),
      }),
    }),
  };
});

const {
  invalidateTenantTelecomCache,
  resolveOrgIdByCalledNumber,
  resolveOrgIdByPatientPhone,
  resolveOrgIdByPatientPhoneDetailed,
} = await import("./tenant-telecom");

beforeEach(() => {
  store.orgs = [
    { id: TENANT_A, sms_from_number: DID_A, voice_from_number: DID_A },
    { id: TENANT_B, sms_from_number: DID_B, voice_from_number: DID_B },
  ];
  store.patients = [];
  store.probes = [];
  store.fail = false;
  invalidateTenantTelecomCache();
});

describe("two tenants, two DIDs", () => {
  it("routes a call to the tenant that owns the dialled number", async () => {
    await expect(resolveOrgIdByCalledNumber(DID_A, "voice")).resolves.toBe(
      TENANT_A,
    );
    invalidateTenantTelecomCache();
    await expect(resolveOrgIdByCalledNumber(DID_B, "voice")).resolves.toBe(
      TENANT_B,
    );
  });

  it("returns null for a number no tenant owns, rather than a default", async () => {
    // Falling back to the seed tenant here would put a stranger's call
    // into a real practice's queue.
    await expect(
      resolveOrgIdByCalledNumber("+15550003333", "voice"),
    ).resolves.toBeNull();
  });

  it("normalizes a bare NANP number before the lookup", async () => {
    // Twilio's `To` is validated as min(1), not E.164. An un-normalized
    // value would never match a stored number — and must never be
    // interpolated raw into a PostgREST filter.
    await expect(
      resolveOrgIdByCalledNumber("5550001111", "voice"),
    ).resolves.toBe(TENANT_A);
  });

  it("refuses a number carrying filter metacharacters", async () => {
    // The directory is GLOBAL. A value that could alter the filter
    // expression could misroute a call into another tenant.
    for (const hostile of [
      "+1555000111,or(id.eq.x)",
      "+1555)00011(1",
      "*",
      "",
    ]) {
      await expect(
        resolveOrgIdByCalledNumber(hostile, "voice"),
      ).resolves.toBeNull();
    }
  });
});

describe("the same DID on different channels", () => {
  beforeEach(() => {
    // Nothing in the database prevents this: the partial unique indexes
    // are per column.
    store.orgs = [
      { id: TENANT_A, sms_from_number: SHARED_DID, voice_from_number: DID_A },
      { id: TENANT_B, sms_from_number: DID_B, voice_from_number: SHARED_DID },
    ];
    invalidateTenantTelecomCache();
  });

  it("routes a VOICE call to the voice owner, not the SMS owner", async () => {
    await expect(resolveOrgIdByCalledNumber(SHARED_DID, "voice")).resolves.toBe(
      TENANT_B,
    );
  });

  it("routes an SMS to the SMS owner", async () => {
    await expect(resolveOrgIdByCalledNumber(SHARED_DID, "sms")).resolves.toBe(
      TENANT_A,
    );
  });

  it("probes ONLY the channel's own column", async () => {
    // A channel-blind probe would try sms_from_number first and answer
    // TENANT_A for a voice call — silently, with every downstream read
    // scoped to the wrong practice.
    store.probes = [];
    await resolveOrgIdByCalledNumber(SHARED_DID, "voice");
    const columns = store.probes
      .filter((p) => p.table === "organizations")
      .map((p) => p.column);
    expect(columns).toEqual(["voice_from_number"]);
  });

  it("does not let one channel's cached answer serve the other", async () => {
    // A kind-blind cache key would hand the voice call the SMS answer.
    await expect(resolveOrgIdByCalledNumber(SHARED_DID, "sms")).resolves.toBe(
      TENANT_A,
    );
    await expect(resolveOrgIdByCalledNumber(SHARED_DID, "voice")).resolves.toBe(
      TENANT_B,
    );
  });
});

describe("caller correlation by patient phone", () => {
  it("resolves a phone that exists in exactly one tenant", async () => {
    store.patients = [
      { id: "p1", org_id: TENANT_A, phone_e164: SHARED_PATIENT_PHONE },
    ];
    await expect(
      resolveOrgIdByPatientPhone(SHARED_PATIENT_PHONE),
    ).resolves.toBe(TENANT_A);
  });

  it("FAILS CLOSED when the phone exists in two tenants", async () => {
    // Recency of contact is not evidence of ownership. Tie-breaking on
    // `last_message_at` would hand this patient's inbound call — and
    // their conversation thread, and any PHI in it — to whichever tenant
    // happened to message the number last.
    store.patients = [
      { id: "p1", org_id: TENANT_A, phone_e164: SHARED_PATIENT_PHONE },
      { id: "p2", org_id: TENANT_B, phone_e164: SHARED_PATIENT_PHONE },
    ];
    await expect(
      resolveOrgIdByPatientPhone(SHARED_PATIENT_PHONE),
    ).resolves.toBeNull();
  });

  it("stays closed however many tenants share the number", async () => {
    store.patients = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`,
      org_id: `3333333${i}-3333-4333-8333-333333333333`,
      phone_e164: SHARED_PATIENT_PHONE,
    }));
    await expect(
      resolveOrgIdByPatientPhone(SHARED_PATIENT_PHONE),
    ).resolves.toBeNull();
  });

  it("ignores patients with no tenant rather than counting them", async () => {
    store.patients = [
      { id: "p1", org_id: TENANT_A, phone_e164: SHARED_PATIENT_PHONE },
      {
        id: "p2",
        org_id: null as unknown as string,
        phone_e164: SHARED_PATIENT_PHONE,
      },
    ];
    await expect(
      resolveOrgIdByPatientPhone(SHARED_PATIENT_PHONE),
    ).resolves.toBe(TENANT_A);
  });

  it("returns null for a number nobody has", async () => {
    await expect(
      resolveOrgIdByPatientPhone("+15550008888"),
    ).resolves.toBeNull();
  });
});

describe("failure posture", () => {
  it("resolves to null when the directory read fails, never to a default", async () => {
    // An unreachable directory must not become "the seed tenant".
    store.fail = true;
    await expect(
      resolveOrgIdByCalledNumber(DID_A, "voice"),
    ).resolves.toBeNull();
    invalidateTenantTelecomCache();
    await expect(
      resolveOrgIdByPatientPhone(SHARED_PATIENT_PHONE),
    ).resolves.toBeNull();
  });

  it("never throws — an inbound webhook must answer Twilio", async () => {
    store.fail = true;
    await expect(
      resolveOrgIdByCalledNumber(DID_A, "voice"),
    ).resolves.toBeNull();
  });
});

describe("attribution precedence", () => {
  it("prefers the DIALLED number over the caller's own tenant", async () => {
    // The dialled number is a fact about which line rang. The caller's
    // phone is a guess about who they are, and the two can disagree when
    // a patient of tenant A calls tenant B's published number.
    store.patients = [
      { id: "p1", org_id: TENANT_A, phone_e164: SHARED_PATIENT_PHONE },
    ];
    const byCalled = await resolveOrgIdByCalledNumber(DID_B, "voice");
    expect(byCalled).toBe(TENANT_B);
    // The route only falls through to the caller lookup when the called
    // number resolved to nothing; this asserts the two are independent.
    await expect(
      resolveOrgIdByPatientPhone(SHARED_PATIENT_PHONE),
    ).resolves.toBe(TENANT_A);
  });
});

describe("the caller lookup says WHY it failed", () => {
  // The three reasons need three different fixes — register the DID,
  // provision a dedicated one, or chase an outage — and only the resolver
  // can tell them apart. A call site that infers the reason from whether
  // a caller number happened to be supplied gets it wrong for every
  // ordinary wrong number, and sends whoever reads the signal to do the
  // wrong repair.

  it("reports the tenant and NO reason on a clean match", async () => {
    store.patients = [
      { id: "p1", org_id: TENANT_A, phone_e164: SHARED_PATIENT_PHONE },
    ];
    await expect(
      resolveOrgIdByPatientPhoneDetailed(SHARED_PATIENT_PHONE),
    ).resolves.toEqual({ orgId: TENANT_A, reason: null });
  });

  it("says `unknown_caller` for a number nobody has", async () => {
    await expect(
      resolveOrgIdByPatientPhoneDetailed("+15550008888"),
    ).resolves.toEqual({ orgId: null, reason: "unknown_caller" });
  });

  it("says `ambiguous_caller` — not unknown — when two tenants share it", async () => {
    store.patients = [
      { id: "p1", org_id: TENANT_A, phone_e164: SHARED_PATIENT_PHONE },
      { id: "p2", org_id: TENANT_B, phone_e164: SHARED_PATIENT_PHONE },
    ];
    await expect(
      resolveOrgIdByPatientPhoneDetailed(SHARED_PATIENT_PHONE),
    ).resolves.toEqual({ orgId: null, reason: "ambiguous_caller" });
  });

  it("says `directory_unavailable` on a failed read, blaming the outage not the caller", async () => {
    store.fail = true;
    await expect(
      resolveOrgIdByPatientPhoneDetailed(SHARED_PATIENT_PHONE),
    ).resolves.toEqual({ orgId: null, reason: "directory_unavailable" });
  });

  it("says `unknown_caller` when there is no usable number at all", async () => {
    for (const input of [undefined, "", "not-a-number"]) {
      await expect(resolveOrgIdByPatientPhoneDetailed(input)).resolves.toEqual({
        orgId: null,
        reason: "unknown_caller",
      });
    }
  });

  it("does NOT cache an outage, so a recovered directory resolves at once", async () => {
    // Caching a failed read would extend a brief outage to the full TTL
    // for every caller who dialled during it — and keep reporting
    // "unavailable" after the directory came back.
    store.fail = true;
    await expect(
      resolveOrgIdByPatientPhoneDetailed(SHARED_PATIENT_PHONE),
    ).resolves.toMatchObject({ reason: "directory_unavailable" });

    store.fail = false;
    store.patients = [
      { id: "p1", org_id: TENANT_A, phone_e164: SHARED_PATIENT_PHONE },
    ];
    // No cache invalidation between these two calls, deliberately.
    await expect(
      resolveOrgIdByPatientPhoneDetailed(SHARED_PATIENT_PHONE),
    ).resolves.toEqual({ orgId: TENANT_A, reason: null });
  });

  it("still caches a real answer, including a negative one", async () => {
    await expect(
      resolveOrgIdByPatientPhoneDetailed(SHARED_PATIENT_PHONE),
    ).resolves.toMatchObject({ reason: "unknown_caller" });
    // The row now exists, but the cached miss stands until the TTL.
    store.patients = [
      { id: "p1", org_id: TENANT_A, phone_e164: SHARED_PATIENT_PHONE },
    ];
    await expect(
      resolveOrgIdByPatientPhoneDetailed(SHARED_PATIENT_PHONE),
    ).resolves.toMatchObject({ orgId: null });
  });

  it("keeps the plain resolver's contract unchanged", async () => {
    // Every existing caller still gets a bare org id or null, and still
    // fails closed on ambiguity.
    store.patients = [
      { id: "p1", org_id: TENANT_A, phone_e164: SHARED_PATIENT_PHONE },
      { id: "p2", org_id: TENANT_B, phone_e164: SHARED_PATIENT_PHONE },
    ];
    await expect(
      resolveOrgIdByPatientPhone(SHARED_PATIENT_PHONE),
    ).resolves.toBeNull();
  });
});

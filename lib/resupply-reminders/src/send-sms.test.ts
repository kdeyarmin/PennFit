// Unit tests for sendReminderSms — focused on the multi-tenant
// org-scoping cutover.
//
// Mocking strategy (mirrors reply.test.ts):
//   - The `supabase` client is an inline table-dispatching stub passed
//     directly to the function. `sendReminderSms` now wraps it with the
//     REAL getOrgScopedClient(orgId, supabase), which injects an extra
//     `.eq("org_id", …)` into every read chain and tags inserts/updates
//     with org_id — so the stub tolerates arbitrary chaining and
//     resolves the terminal by (table, op).
//   - @workspace/resupply-db: getOrgScopedClient stays REAL; only
//     tryUpsertPatientLatestMessageSb (best-effort projection) and
//     resolveSeedOrgId (the seed-org bridge) are overridden.
//   - @workspace/resupply-telecom: createTwilioSmsClient → sendSmsMock
//   - ./safe-audit: safeAuditFromActor observed without resupply-audit.

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  patientReadMock,
  episodeReadMock,
  convInsertMock,
  convUpdateMock,
  convDeleteMock,
  msgInsertMock,
  tryUpsertMock,
  resolveSeedOrgIdMock,
  sendSmsMock,
  safeAuditMock,
} = vi.hoisted(() => ({
  patientReadMock: vi.fn(),
  episodeReadMock: vi.fn(),
  convInsertMock: vi.fn(),
  convUpdateMock: vi.fn(),
  convDeleteMock: vi.fn(),
  msgInsertMock: vi.fn(),
  tryUpsertMock: vi.fn(),
  resolveSeedOrgIdMock: vi.fn(),
  sendSmsMock: vi.fn(),
  safeAuditMock: vi.fn(),
}));

vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return {
    ...actual,
    tryUpsertPatientLatestMessageSb: tryUpsertMock,
    resolveSeedOrgId: resolveSeedOrgIdMock,
  };
});

vi.mock("@workspace/resupply-telecom", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-telecom")
  >("@workspace/resupply-telecom");
  return {
    ...actual,
    createTwilioSmsClient: () => ({ sendSms: sendSmsMock }),
  };
});

vi.mock("./safe-audit", () => ({
  safeAuditFromActor: safeAuditMock,
}));

import { sendReminderSms } from "./send-sms";

// ---------------------------------------------------------------------------
// Supabase stub factory — fully chainable (table, op) dispatcher.
// ---------------------------------------------------------------------------
function makeSupabase() {
  const terminalFor = (table: string, op: string): (() => unknown) => {
    if (table === "patients" && op === "select") return patientReadMock;
    if (table === "episodes" && op === "select") return episodeReadMock;
    if (table === "conversations" && op === "insert") return convInsertMock;
    if (table === "conversations" && op === "update") return convUpdateMock;
    if (table === "conversations" && op === "delete") return convDeleteMock;
    if (table === "messages" && op === "insert") return msgInsertMock;
    return async () => ({ data: null, error: null });
  };
  const makeChain = (table: string, op: string) => {
    const term = () => terminalFor(table, op)() as Promise<unknown>;
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      lt: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => term(),
      single: () => term(),
      then: (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
      ) => term().then(resolve, reject),
    };
    return chain;
  };
  return {
    schema: (_schema: string) => ({
      from: (table: string) => ({
        select: () => makeChain(table, "select"),
        insert: () => makeChain(table, "insert"),
        update: () => makeChain(table, "update"),
        delete: () => makeChain(table, "delete"),
      }),
    }),
  } as never;
}

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PATIENT_ID = "pppppppp-pppp-4ppp-8ppp-pppppppppppp";
const EPISODE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CONVERSATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const SMS_CFG = {
  twilioAccountSid: "ACtest",
  twilioAuthToken: "auth-token",
  twilioPhoneNumber: "+12125550100",
  twilioMessagingServiceSid: undefined,
  publicBaseUrl: "https://test.example.com",
  practiceName: "Test Practice",
};

const SYSTEM_ACTOR = { kind: "system" as const, jobId: "job_1" };

function makeInput(overrides?: Partial<Parameters<typeof sendReminderSms>[0]>) {
  return {
    supabase: makeSupabase(),
    orgId: ORG_ID,
    cfg: SMS_CFG,
    patientId: PATIENT_ID,
    episodeId: EPISODE_ID,
    body: "Custom reminder body",
    actor: SYSTEM_ACTOR,
    ...overrides,
  };
}

// Stage the standard happy-path responses. patients is read twice (by
// id, then the phone-uniqueness check), so the first call returns the
// patient row and the second returns only this same patient (no
// conflicting owner).
function stageHappyPath() {
  patientReadMock
    .mockResolvedValueOnce({
      data: {
        id: PATIENT_ID,
        status: "active",
        phone_e164: "+12155551212",
        legal_first_name: "Joan",
      },
      error: null,
    })
    .mockResolvedValue({ data: [{ id: PATIENT_ID }], error: null });
  episodeReadMock.mockResolvedValue({
    data: { id: EPISODE_ID, patient_id: PATIENT_ID },
    error: null,
  });
  convInsertMock.mockResolvedValue({
    data: { id: CONVERSATION_ID },
    error: null,
  });
  msgInsertMock.mockResolvedValue({ error: null });
  convUpdateMock.mockResolvedValue({ error: null });
  sendSmsMock.mockResolvedValue({ messageSid: "SM_TEST_1" });
}

beforeEach(() => {
  patientReadMock.mockReset();
  episodeReadMock.mockReset();
  convInsertMock.mockReset();
  convUpdateMock.mockReset();
  convDeleteMock.mockReset().mockResolvedValue({ error: null });
  msgInsertMock.mockReset();
  tryUpsertMock.mockReset().mockResolvedValue(true);
  resolveSeedOrgIdMock.mockReset().mockResolvedValue(ORG_ID);
  sendSmsMock.mockReset();
  safeAuditMock.mockReset().mockResolvedValue(undefined);
});

describe("sendReminderSms — org-scoped happy path", () => {
  it("sends, persists, and returns ok with the explicit orgId", async () => {
    stageHappyPath();

    const result = await sendReminderSms(makeInput());

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.conversationId).toBe(CONVERSATION_ID);
      expect(result.vendorRef).toBe("SM_TEST_1");
    }
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    // Explicit orgId supplied — the seed-org bridge must NOT be hit.
    expect(resolveSeedOrgIdMock).not.toHaveBeenCalled();
  });

  it("forwards the resolved orgId to the latest-message projection", async () => {
    stageHappyPath();

    await sendReminderSms(makeInput());

    expect(tryUpsertMock).toHaveBeenCalledTimes(1);
    expect(tryUpsertMock.mock.calls[0][1].orgId).toBe(ORG_ID);
  });
});

describe("sendReminderSms — seed-org bridge", () => {
  it("resolves the seed tenant when orgId is omitted", async () => {
    stageHappyPath();

    const result = await sendReminderSms(makeInput({ orgId: undefined }));

    expect(result.status).toBe("ok");
    expect(resolveSeedOrgIdMock).toHaveBeenCalledTimes(1);
    // The bridge-resolved org propagates to the projection too.
    expect(tryUpsertMock.mock.calls[0][1].orgId).toBe(ORG_ID);
  });
});

describe("sendReminderSms — early exits", () => {
  it("returns patient_not_found when the patient row is absent", async () => {
    patientReadMock.mockResolvedValueOnce({ data: null, error: null });

    const result = await sendReminderSms(makeInput());
    expect(result.status).toBe("patient_not_found");
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("refuses to send when the phone is bound to another patient", async () => {
    patientReadMock
      .mockResolvedValueOnce({
        data: {
          id: PATIENT_ID,
          status: "active",
          phone_e164: "+12155551212",
          legal_first_name: "Joan",
        },
        error: null,
      })
      // phone-uniqueness check surfaces a DIFFERENT owner
      .mockResolvedValue({
        data: [{ id: PATIENT_ID }, { id: "other-patient" }],
        error: null,
      });
    episodeReadMock.mockResolvedValue({
      data: { id: EPISODE_ID, patient_id: PATIENT_ID },
      error: null,
    });

    const result = await sendReminderSms(makeInput());
    expect(result.status).toBe("phone_in_use_by_other_patient");
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(safeAuditMock).toHaveBeenCalledTimes(1);
    expect(safeAuditMock.mock.calls[0][0].action).toBe(
      "messaging.phone_lookup.conflict",
    );
  });
});

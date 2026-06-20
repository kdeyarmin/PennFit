// Unit tests for sendReminderEmail — focused on the multi-tenant
// org-scoping cutover. See send-sms.test.ts for the mocking strategy;
// this mirrors it for the email channel (no phone-uniqueness check; a
// prescription read feeds the templated items list).

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const {
  patientReadMock,
  episodeReadMock,
  prescriptionReadMock,
  convInsertMock,
  convUpdateMock,
  convDeleteMock,
  msgInsertMock,
  tryUpsertMock,
  resolveSeedOrgIdMock,
  sendEmailMock,
  safeAuditMock,
} = vi.hoisted(() => ({
  patientReadMock: vi.fn(),
  episodeReadMock: vi.fn(),
  prescriptionReadMock: vi.fn(),
  convInsertMock: vi.fn(),
  convUpdateMock: vi.fn(),
  convDeleteMock: vi.fn(),
  msgInsertMock: vi.fn(),
  tryUpsertMock: vi.fn(),
  resolveSeedOrgIdMock: vi.fn(),
  sendEmailMock: vi.fn(),
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

vi.mock("@workspace/resupply-email", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-email")
  >("@workspace/resupply-email");
  return {
    ...actual,
    createSendgridClient: () => ({ sendEmail: sendEmailMock }),
  };
});

vi.mock("./safe-audit", () => ({
  safeAuditFromActor: safeAuditMock,
}));

import { sendReminderEmail } from "./send-email";

function makeSupabase() {
  const terminalFor = (table: string, op: string): (() => unknown) => {
    if (table === "patients" && op === "select") return patientReadMock;
    if (table === "episodes" && op === "select") return episodeReadMock;
    if (table === "prescriptions" && op === "select")
      return prescriptionReadMock;
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
const PRESCRIPTION_ID = "rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr";
const CONVERSATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const EMAIL_CFG = {
  sendgridApiKey: "SG.testkey",
  sendgridFromEmail: "noreply@test.example",
  sendgridFromName: "Test Practice",
  publicBaseUrl: "https://test.example.com",
  practiceName: "Test Practice",
};

const SYSTEM_ACTOR = { kind: "system" as const, jobId: "job_1" };

function makeInput(
  overrides?: Partial<Parameters<typeof sendReminderEmail>[0]>,
) {
  return {
    supabase: makeSupabase(),
    orgId: ORG_ID,
    cfg: EMAIL_CFG,
    patientId: PATIENT_ID,
    episodeId: EPISODE_ID,
    actor: SYSTEM_ACTOR,
    ...overrides,
  };
}

function stageHappyPath() {
  patientReadMock.mockResolvedValue({
    data: {
      id: PATIENT_ID,
      status: "active",
      email: "joan@example.com",
      legal_first_name: "Joan",
    },
    error: null,
  });
  episodeReadMock.mockResolvedValue({
    data: {
      id: EPISODE_ID,
      patient_id: PATIENT_ID,
      prescription_id: PRESCRIPTION_ID,
    },
    error: null,
  });
  prescriptionReadMock.mockResolvedValue({
    data: { item_sku: "MASK-001" },
    error: null,
  });
  convInsertMock.mockResolvedValue({
    data: { id: CONVERSATION_ID },
    error: null,
  });
  msgInsertMock.mockResolvedValue({ error: null });
  convUpdateMock.mockResolvedValue({ error: null });
  sendEmailMock.mockResolvedValue({ messageId: "SG_TEST_1" });
}

// sendReminderEmail signs confirm/edit/stop link tokens, which require
// RESUPPLY_LINK_HMAC_KEY (32-byte base64, per the preflight contract).
const SAVED_LINK_KEY = process.env.RESUPPLY_LINK_HMAC_KEY;

beforeEach(() => {
  process.env.RESUPPLY_LINK_HMAC_KEY = Buffer.alloc(32, 0x11).toString(
    "base64",
  );
  patientReadMock.mockReset();
  episodeReadMock.mockReset();
  prescriptionReadMock.mockReset();
  convInsertMock.mockReset();
  convUpdateMock.mockReset();
  convDeleteMock.mockReset().mockResolvedValue({ error: null });
  msgInsertMock.mockReset();
  tryUpsertMock.mockReset().mockResolvedValue(true);
  resolveSeedOrgIdMock.mockReset().mockResolvedValue(ORG_ID);
  sendEmailMock.mockReset();
  safeAuditMock.mockReset().mockResolvedValue(undefined);
});

afterAll(() => {
  if (SAVED_LINK_KEY === undefined) delete process.env.RESUPPLY_LINK_HMAC_KEY;
  else process.env.RESUPPLY_LINK_HMAC_KEY = SAVED_LINK_KEY;
});

describe("sendReminderEmail — org-scoped happy path", () => {
  it("sends, persists, and returns ok with the explicit orgId", async () => {
    stageHappyPath();

    const result = await sendReminderEmail(makeInput());

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.conversationId).toBe(CONVERSATION_ID);
      expect(result.vendorRef).toBe("SG_TEST_1");
    }
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(resolveSeedOrgIdMock).not.toHaveBeenCalled();
  });

  it("forwards the resolved orgId to the latest-message projection", async () => {
    stageHappyPath();

    await sendReminderEmail(makeInput());

    expect(tryUpsertMock).toHaveBeenCalledTimes(1);
    expect(tryUpsertMock.mock.calls[0][1].orgId).toBe(ORG_ID);
  });
});

describe("sendReminderEmail — seed-org bridge", () => {
  it("resolves the seed tenant when orgId is omitted", async () => {
    stageHappyPath();

    const result = await sendReminderEmail(makeInput({ orgId: undefined }));

    expect(result.status).toBe("ok");
    expect(resolveSeedOrgIdMock).toHaveBeenCalledTimes(1);
    expect(tryUpsertMock.mock.calls[0][1].orgId).toBe(ORG_ID);
  });
});

describe("sendReminderEmail — early exits", () => {
  it("returns patient_missing_email when no email is on file", async () => {
    patientReadMock.mockResolvedValue({
      data: {
        id: PATIENT_ID,
        status: "active",
        email: null,
        legal_first_name: "Joan",
      },
      error: null,
    });

    const result = await sendReminderEmail(makeInput());
    expect(result.status).toBe("patient_missing_email");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

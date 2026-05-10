// Unit tests for replyInConversation.
//
// Mocking strategy:
//   - The `supabase` client is constructed inline as a table-dispatching stub
//     and passed directly to the function (reply.ts takes it as an argument).
//   - @workspace/resupply-db: only tryUpsertPatientLatestMessageSb is mocked
//     (the rest of the db module is not needed at this layer).
//   - @workspace/resupply-telecom: createTwilioSmsClient → sendSmsMock
//   - @workspace/resupply-email: createSendgridClient → sendEmailMock
//   - ./safe-audit: safeAuditFromActor is mocked to observe audit calls
//     without needing @workspace/resupply-audit.
//
// The Supabase stub dispatches on table name so each query path is
// separately controllable:
//
//   conversations (read):  .select().eq().limit(1).maybeSingle()
//   patients     (read):  .select().eq().limit(1).maybeSingle()
//   messages     (insert): .insert().select().limit(1).maybeSingle()
//   conversations (update): .update().eq()  — awaited directly (PromiseLike)

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  convReadMock,
  convUpdateMock,
  patientReadMock,
  msgInsertMock,
  tryUpsertMock,
  sendSmsMock,
  sendEmailMock,
  safeAuditMock,
} = vi.hoisted(() => ({
  convReadMock: vi.fn(),
  convUpdateMock: vi.fn(),
  patientReadMock: vi.fn(),
  msgInsertMock: vi.fn(),
  tryUpsertMock: vi.fn(),
  sendSmsMock: vi.fn(),
  sendEmailMock: vi.fn(),
  safeAuditMock: vi.fn(),
}));

// Mock @workspace/resupply-db — only override tryUpsertPatientLatestMessageSb
// (best-effort projection, not what we're testing here).
vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return {
    ...actual,
    tryUpsertPatientLatestMessageSb: tryUpsertMock,
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

import { replyInConversation } from "./reply";

// ---------------------------------------------------------------------------
// Supabase stub factory
//
// reply.ts calls these query chains in order:
//   1. conversations SELECT (.select.eq.limit.maybeSingle)
//   2. patients SELECT (.select.eq.limit.maybeSingle)
//   3. messages INSERT (.insert.select.limit.maybeSingle) — inside try/catch
//   4. conversations UPDATE (.update.eq) — inside try/catch, awaited directly
//
// The conversations table is accessed in two ways so the dispatch returns an
// object with both `select` (read) and `update` (write) branches.
// ---------------------------------------------------------------------------

function makeSupabase() {
  return {
    schema: (_schema: string) => ({
      from: (table: string) => {
        if (table === "conversations") {
          return {
            // Read path
            select: () => ({
              eq: () => ({ limit: () => ({ maybeSingle: convReadMock }) }),
            }),
            // Write path — .update({}).eq(field, val) is awaited directly.
            // We wrap convUpdateMock in a PromiseLike so `await` works even
            // without an explicit terminal method.
            update: () => ({
              eq: convUpdateMock,
            }),
          };
        }
        if (table === "patients") {
          return {
            select: () => ({
              eq: () => ({ limit: () => ({ maybeSingle: patientReadMock }) }),
            }),
          };
        }
        if (table === "messages") {
          return {
            insert: () => ({
              select: () => ({
                limit: () => ({ maybeSingle: msgInsertMock }),
              }),
            }),
          };
        }
        // Fallback for unexpected tables — return no-op
        return {
          select: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
          update: () => ({
            eq: async () => ({ error: null }),
          }),
        };
      },
    }),
  } as never;
}

// ---------------------------------------------------------------------------
// Test constants & shared input
// ---------------------------------------------------------------------------

const CONVERSATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PATIENT_ID = "pppppppp-pppp-4ppp-8ppp-pppppppppppp";
const MESSAGE_ID = "mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm";

const ADMIN_ACTOR = {
  kind: "admin" as const,
  adminEmail: "ops@penn.example.com",
  adminUserId: "user_op",
  ip: "10.0.0.1",
  userAgent: "vitest/1.0",
};

const SMS_CFG = {
  twilioAccountSid: "ACtest",
  twilioAuthToken: "auth-token",
  twilioPhoneNumber: "+12125550100",
  twilioMessagingServiceSid: undefined,
  publicBaseUrl: "https://test.example.com",
  practiceName: "Test Practice",
};

const EMAIL_CFG = {
  sendgridApiKey: "SG.testkey",
  sendgridFromEmail: "noreply@test.example",
  sendgridFromName: "Test Practice",
  sendgridEventWebhookPublicKey: undefined,
  publicBaseUrl: "https://test.example.com",
  practiceName: "Test Practice",
};

function makeInput(overrides?: Partial<Parameters<typeof replyInConversation>[0]>) {
  return {
    supabase: makeSupabase(),
    smsCfg: SMS_CFG,
    emailCfg: EMAIL_CFG,
    conversationId: CONVERSATION_ID,
    body: "Hello, this is a reply!",
    actor: ADMIN_ACTOR,
    ...overrides,
  };
}

beforeEach(() => {
  convReadMock.mockReset();
  convUpdateMock.mockReset();
  patientReadMock.mockReset();
  msgInsertMock.mockReset();
  tryUpsertMock.mockReset().mockResolvedValue(true);
  sendSmsMock.mockReset();
  sendEmailMock.mockReset();
  safeAuditMock.mockReset().mockResolvedValue(undefined);
  // Default: update succeeds
  convUpdateMock.mockResolvedValue({ error: null });
});

// ---------------------------------------------------------------------------
// Early-exit paths
// ---------------------------------------------------------------------------

describe("replyInConversation — early exits", () => {
  it("returns conversation_not_found when conversation row is absent", async () => {
    convReadMock.mockResolvedValue({ data: null, error: null });

    const result = await replyInConversation(makeInput());
    expect(result.status).toBe("conversation_not_found");
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("throws when conversations SELECT returns a Supabase error", async () => {
    const dbErr = Object.assign(new Error("PostgREST error"), { code: "PGRST" });
    convReadMock.mockResolvedValue({ data: null, error: dbErr });

    await expect(replyInConversation(makeInput())).rejects.toThrow("PostgREST error");
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("returns conversation_closed when status is closed", async () => {
    convReadMock.mockResolvedValue({
      data: {
        id: CONVERSATION_ID,
        patient_id: PATIENT_ID,
        episode_id: null,
        channel: "sms",
        status: "closed",
      },
      error: null,
    });

    const result = await replyInConversation(makeInput());
    expect(result.status).toBe("conversation_closed");
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("returns patient_missing_contact for voice channel", async () => {
    convReadMock.mockResolvedValue({
      data: {
        id: CONVERSATION_ID,
        patient_id: PATIENT_ID,
        episode_id: null,
        channel: "voice",
        status: "open",
      },
      error: null,
    });

    const result = await replyInConversation(makeInput());
    expect(result.status).toBe("patient_missing_contact");
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("returns unsupported_channel for in_app channel", async () => {
    convReadMock.mockResolvedValue({
      data: {
        id: CONVERSATION_ID,
        patient_id: null,
        episode_id: null,
        channel: "in_app",
        status: "open",
      },
      error: null,
    });

    const result = await replyInConversation(makeInput());
    expect(result.status).toBe("unsupported_channel");
    if (result.status === "unsupported_channel") {
      expect(result.channel).toBe("in_app");
    }
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("returns conversation_not_found when patient_id is null (corrupted row)", async () => {
    convReadMock.mockResolvedValue({
      data: {
        id: CONVERSATION_ID,
        patient_id: null,
        episode_id: null,
        channel: "sms",
        status: "open",
      },
      error: null,
    });

    const result = await replyInConversation(makeInput());
    expect(result.status).toBe("conversation_not_found");
    expect(sendSmsMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Patient lookup paths
// ---------------------------------------------------------------------------

describe("replyInConversation — patient lookup", () => {
  beforeEach(() => {
    convReadMock.mockResolvedValue({
      data: {
        id: CONVERSATION_ID,
        patient_id: PATIENT_ID,
        episode_id: null,
        channel: "sms",
        status: "open",
      },
      error: null,
    });
  });

  it("throws when patients SELECT returns a Supabase error", async () => {
    const dbErr = new Error("patients table error");
    patientReadMock.mockResolvedValue({ data: null, error: dbErr });

    await expect(replyInConversation(makeInput())).rejects.toThrow(
      "patients table error",
    );
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("returns patient_missing_contact when patient row is absent (SMS)", async () => {
    patientReadMock.mockResolvedValue({ data: null, error: null });

    const result = await replyInConversation(makeInput());
    expect(result.status).toBe("patient_missing_contact");
    if (result.status === "patient_missing_contact") {
      expect(result.channel).toBe("sms");
    }
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("returns patient_missing_contact when SMS patient has no phone_e164", async () => {
    patientReadMock.mockResolvedValue({
      data: { id: PATIENT_ID, phone_e164: null, email: null },
      error: null,
    });

    const result = await replyInConversation(makeInput());
    expect(result.status).toBe("patient_missing_contact");
    if (result.status === "patient_missing_contact") {
      expect(result.channel).toBe("sms");
    }
  });

  it("returns patient_phone_unnormalizable when phone cannot be normalized", async () => {
    patientReadMock.mockResolvedValue({
      data: {
        id: PATIENT_ID,
        phone_e164: "000-not-valid",
        email: null,
      },
      error: null,
    });

    const result = await replyInConversation(makeInput());
    expect(result.status).toBe("patient_phone_unnormalizable");
    expect(sendSmsMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SMS happy path
// ---------------------------------------------------------------------------

describe("replyInConversation — SMS success path", () => {
  beforeEach(() => {
    convReadMock.mockResolvedValue({
      data: {
        id: CONVERSATION_ID,
        patient_id: PATIENT_ID,
        episode_id: "ep-001",
        channel: "sms",
        status: "open",
      },
      error: null,
    });
    patientReadMock.mockResolvedValue({
      data: { id: PATIENT_ID, phone_e164: "+12155551212", email: null },
      error: null,
    });
    sendSmsMock.mockResolvedValue({ messageSid: "SM_TEST_123" });
    msgInsertMock.mockResolvedValue({
      data: { id: MESSAGE_ID },
      error: null,
    });
    convUpdateMock.mockResolvedValue({ error: null });
  });

  it("returns status=ok with conversationId, messageId, and vendorRef", async () => {
    const result = await replyInConversation(makeInput());

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.conversationId).toBe(CONVERSATION_ID);
      expect(result.messageId).toBe(MESSAGE_ID);
      expect(result.vendorRef).toBe("SM_TEST_123");
    }
  });

  it("calls Twilio sendSms with the normalized phone and correct body", async () => {
    await replyInConversation(makeInput());

    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    const smsArgs = sendSmsMock.mock.calls[0][0];
    expect(smsArgs.to).toBe("+12155551212");
    expect(smsArgs.body).toBe("Hello, this is a reply!");
    // Status callback URL must contain conversationId.
    expect(smsArgs.statusCallbackUrl).toContain(
      `conversationId=${encodeURIComponent(CONVERSATION_ID)}`,
    );
  });

  it("audits the send with action=messaging.reply.sent and status=ok", async () => {
    await replyInConversation(makeInput());

    expect(safeAuditMock).toHaveBeenCalledTimes(1);
    const auditCall = safeAuditMock.mock.calls[0][0];
    expect(auditCall.action).toBe("messaging.reply.sent");
    expect(auditCall.metadata.status).toBe("ok");
    expect(auditCall.metadata.channel).toBe("sms");
    expect(auditCall.metadata.patient_id).toBe(PATIENT_ID);
    // PHI scrub: no phone number in metadata
    const meta = JSON.stringify(auditCall.metadata);
    expect(meta).not.toContain("+12155551212");
  });

  it("calls tryUpsertPatientLatestMessageSb for projection refresh", async () => {
    await replyInConversation(makeInput());

    expect(tryUpsertMock).toHaveBeenCalledTimes(1);
    const upsertArgs = tryUpsertMock.mock.calls[0];
    expect(upsertArgs[1].conversationId).toBe(CONVERSATION_ID);
    expect(upsertArgs[1].direction).toBe("outbound");
    expect(upsertArgs[1].body).toBe("Hello, this is a reply!");
  });

  it("still returns ok even when the DB write fails after Twilio acceptance", async () => {
    // Vendor accepted → DB error must NOT propagate (would cause
    // the caller to retry and send a duplicate SMS).
    msgInsertMock.mockResolvedValue({
      data: null,
      error: new Error("DB insert failed"),
    });

    const result = await replyInConversation(makeInput());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      // messageId is undefined when the insert failed
      expect(result.messageId).toBeUndefined();
      expect(result.vendorRef).toBe("SM_TEST_123");
    }
  });
});

// ---------------------------------------------------------------------------
// SMS vendor errors
// ---------------------------------------------------------------------------

describe("replyInConversation — SMS vendor errors", () => {
  beforeEach(() => {
    convReadMock.mockResolvedValue({
      data: {
        id: CONVERSATION_ID,
        patient_id: PATIENT_ID,
        episode_id: null,
        channel: "sms",
        status: "open",
      },
      error: null,
    });
    patientReadMock.mockResolvedValue({
      data: { id: PATIENT_ID, phone_e164: "+12155551212", email: null },
      error: null,
    });
  });

  it("returns vendor_api_error and audits twilio_error on TwilioApiError", async () => {
    const { TwilioApiError } = await import("@workspace/resupply-telecom");
    sendSmsMock.mockRejectedValue(new TwilioApiError("Undeliverable", 400, "21610"));

    const result = await replyInConversation(makeInput());

    expect(result.status).toBe("vendor_api_error");
    if (result.status === "vendor_api_error") {
      expect(result.vendor).toBe("sms_vendor");
      expect(result.vendorStatus).toBe(400);
      expect(result.vendorCode).toBe("21610");
    }
    // No DB writes happen on vendor failure before message insert.
    expect(msgInsertMock).not.toHaveBeenCalled();

    // Audit should record twilio_error
    expect(safeAuditMock).toHaveBeenCalledTimes(1);
    expect(safeAuditMock.mock.calls[0][0].metadata.status).toBe("twilio_error");
  });

  it("re-throws TwilioConfigError (must not be swallowed)", async () => {
    const { TwilioConfigError } = await import("@workspace/resupply-telecom");
    sendSmsMock.mockRejectedValue(new TwilioConfigError("missing credentials"));

    await expect(replyInConversation(makeInput())).rejects.toBeInstanceOf(
      TwilioConfigError,
    );
  });
});

// ---------------------------------------------------------------------------
// Email channel
// ---------------------------------------------------------------------------

describe("replyInConversation — email channel", () => {
  beforeEach(() => {
    convReadMock.mockResolvedValue({
      data: {
        id: CONVERSATION_ID,
        patient_id: PATIENT_ID,
        episode_id: "ep-email-001",
        channel: "email",
        status: "open",
      },
      error: null,
    });
  });

  it("returns patient_missing_contact when email patient has no email address", async () => {
    patientReadMock.mockResolvedValue({
      data: { id: PATIENT_ID, phone_e164: null, email: null },
      error: null,
    });

    const result = await replyInConversation(makeInput());
    expect(result.status).toBe("patient_missing_contact");
    if (result.status === "patient_missing_contact") {
      expect(result.channel).toBe("email");
    }
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("returns ok and audits status=ok on email success", async () => {
    patientReadMock.mockResolvedValue({
      data: { id: PATIENT_ID, phone_e164: null, email: "joan@example.com" },
      error: null,
    });
    sendEmailMock.mockResolvedValue({ messageId: "SG_MSG_999" });
    msgInsertMock.mockResolvedValue({
      data: { id: MESSAGE_ID },
      error: null,
    });
    convUpdateMock.mockResolvedValue({ error: null });

    const result = await replyInConversation(makeInput());

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.vendorRef).toBe("SG_MSG_999");
      expect(result.messageId).toBe(MESSAGE_ID);
    }

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const emailArgs = sendEmailMock.mock.calls[0][0];
    expect(emailArgs.to).toBe("joan@example.com");
    // PHI scrub: email address NOT in audit metadata
    expect(safeAuditMock).toHaveBeenCalledTimes(1);
    const auditMeta = JSON.stringify(safeAuditMock.mock.calls[0][0].metadata);
    expect(auditMeta).not.toContain("joan@example.com");
  });

  it("returns vendor_api_error and audits sendgrid_error on EmailApiError", async () => {
    patientReadMock.mockResolvedValue({
      data: { id: PATIENT_ID, phone_e164: null, email: "joan@example.com" },
      error: null,
    });
    const { EmailApiError } = await import("@workspace/resupply-email");
    sendEmailMock.mockRejectedValue(new EmailApiError("rejected", 400));

    const result = await replyInConversation(makeInput());

    expect(result.status).toBe("vendor_api_error");
    if (result.status === "vendor_api_error") {
      expect(result.vendor).toBe("email_vendor");
      expect(result.vendorStatus).toBe(400);
    }
    expect(msgInsertMock).not.toHaveBeenCalled();

    expect(safeAuditMock).toHaveBeenCalledTimes(1);
    expect(safeAuditMock.mock.calls[0][0].metadata.status).toBe("sendgrid_error");
  });

  it("re-throws EmailConfigError (must not be swallowed)", async () => {
    patientReadMock.mockResolvedValue({
      data: { id: PATIENT_ID, phone_e164: null, email: "joan@example.com" },
      error: null,
    });
    const { EmailConfigError } = await import("@workspace/resupply-email");
    sendEmailMock.mockRejectedValue(new EmailConfigError("missing SENDGRID_API_KEY"));

    await expect(replyInConversation(makeInput())).rejects.toBeInstanceOf(
      EmailConfigError,
    );
  });

  it("email subject includes practice name", async () => {
    patientReadMock.mockResolvedValue({
      data: { id: PATIENT_ID, phone_e164: null, email: "joan@example.com" },
      error: null,
    });
    sendEmailMock.mockResolvedValue({ messageId: "SG_SUBJ" });
    msgInsertMock.mockResolvedValue({ data: { id: MESSAGE_ID }, error: null });
    convUpdateMock.mockResolvedValue({ error: null });

    await replyInConversation(makeInput());

    const emailArgs = sendEmailMock.mock.calls[0][0];
    expect(emailArgs.subject).toContain("Test Practice");
  });
});

// ---------------------------------------------------------------------------
// Audit metadata — PHI scrubbing
// ---------------------------------------------------------------------------

describe("replyInConversation — PHI scrubbing in audit metadata", () => {
  it("body_length is in metadata but body text is not", async () => {
    convReadMock.mockResolvedValue({
      data: {
        id: CONVERSATION_ID,
        patient_id: PATIENT_ID,
        episode_id: null,
        channel: "sms",
        status: "open",
      },
      error: null,
    });
    patientReadMock.mockResolvedValue({
      data: { id: PATIENT_ID, phone_e164: "+12155551212", email: null },
      error: null,
    });
    sendSmsMock.mockResolvedValue({ messageSid: "SM_PHI_TEST" });
    msgInsertMock.mockResolvedValue({ data: { id: MESSAGE_ID }, error: null });
    convUpdateMock.mockResolvedValue({ error: null });

    const customBody = "Hi Joan! Your supplies are ready.";
    await replyInConversation(makeInput({ body: customBody }));

    const auditMeta = safeAuditMock.mock.calls[0][0].metadata;
    // body_length is structural metadata — must be present
    expect(auditMeta.body_length).toBe(customBody.length);
    // actual body text and phone must NOT appear in metadata
    const metaStr = JSON.stringify(auditMeta);
    expect(metaStr).not.toContain("Joan");
    expect(metaStr).not.toContain("Hi Joan");
    expect(metaStr).not.toContain("+12155551212");
  });
});

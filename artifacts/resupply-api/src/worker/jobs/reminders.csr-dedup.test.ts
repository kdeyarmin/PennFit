import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type PgBoss from "pg-boss";
import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  registerReminderJobs,
  releaseReminderDedupKey,
  tryClaimReminderDedupKey,
} from "./reminders";
import { registerReminderVoiceJob } from "./reminder-voice";

const mocks = vi.hoisted(() => ({
  sms: vi.fn(),
  email: vi.fn(),
  voice: vi.fn(),
  markAwaiting: vi.fn(),
  company: vi.fn(),
  smsProvider: vi.fn(),
  emailProvider: vi.fn(),
  voiceProvider: vi.fn(),
  pendingRegister: vi.fn(),
  pendingAttach: vi.fn(),
}));
vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return {
    ...actual,
    tryUpsertPatientLatestMessageSb: vi.fn(),
    getOrgScopedClient: (
      org: string,
      raw?: Parameters<typeof actual.getOrgScopedClient>[1],
    ) => actual.getOrgScopedClient(org, raw ?? createRaw()),
  };
});
vi.mock("@workspace/resupply-reminders", async () => ({
  ...(await vi.importActual<typeof import("@workspace/resupply-reminders")>(
    "@workspace/resupply-reminders",
  )),
  sendReminderSms: mocks.sms,
  sendReminderEmail: mocks.email,
}));
vi.mock("@workspace/resupply-secrets", async () => ({
  ...(await vi.importActual<typeof import("@workspace/resupply-secrets")>(
    "@workspace/resupply-secrets",
  )),
  hasLinkHmacKey: () => true,
}));
vi.mock("@workspace/resupply-telecom", async () => ({
  ...(await vi.importActual<typeof import("@workspace/resupply-telecom")>(
    "@workspace/resupply-telecom",
  )),
  createTwilioSmsClient: () => ({ sendSms: mocks.smsProvider }),
  createTwilioClient: () => ({ placeCall: mocks.voiceProvider }),
}));
vi.mock("@workspace/resupply-email", async () => ({
  ...(await vi.importActual<typeof import("@workspace/resupply-email")>(
    "@workspace/resupply-email",
  )),
  createSendgridClient: () => ({ sendEmail: mocks.emailProvider }),
}));
vi.mock("../../lib/resupply/csr-outreach", () => ({
  checkCsrOutreach: async () => ({ reason: null }),
}));
vi.mock("../../lib/company-info", () => ({ getCompanyInfo: mocks.company }));
vi.mock("../../lib/messaging/tenant-telecom", () => ({
  applyTenantSmsFrom: async (_org: string, cfg: unknown) => cfg,
  resolveTenantVoiceFrom: async () => null,
}));
vi.mock("../../lib/email/apply-tenant-email-sender", () => ({
  applyTenantEmailSender: async (_org: string, cfg: unknown) => cfg,
  isPatientEmailClickBaseReady: () => true,
}));
vi.mock("../../lib/episodes/mark-awaiting-response", () => ({
  markEpisodeAwaitingResponse: mocks.markAwaiting,
}));
vi.mock("../../lib/metering/usage", () => ({
  recordOutboundMessageUsage: vi.fn(),
  recordTenantUsage: vi.fn(),
}));
vi.mock("../../lib/voice/place-outbound-call", () => ({
  placeOutboundReorderCall: mocks.voice,
}));
vi.mock("../../lib/voice/voice-config", () => ({
  readVoiceConfigOrNull: () => ({
    twilioPhoneNumber: "+15555550100",
    twilioAccountSid: "test-account",
    twilioAuthToken: "test-token",
    publicBaseUrl: "https://practice.example.test",
  }),
}));
vi.mock("../../lib/voice/pending-sessions", () => ({
  getPendingSessions: () => ({
    register: mocks.pendingRegister,
    attachCallSid: mocks.pendingAttach,
  }),
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let database: PGlite;
const patientId = "11111111-1111-4111-8111-111111111111";
const episodeId = "22222222-2222-4222-8222-222222222222";
const orgId = "33333333-3333-4333-8333-333333333333";
type FixtureRow = Record<string, unknown>;
let conversations: FixtureRow[] = [];
let messages: FixtureRow[] = [];
const readFailures = new Map<string, Error>();

// Real send helpers exercise their preparation and provider boundary against
// synthetic entity rows. Only claim contention requires the PostgreSQL engine.
function entityQuery(table: string) {
  let operation = "select";
  let columns = "";
  let payload: FixtureRow = {};
  const filters = new Map<string, unknown>();
  const matches = (row: FixtureRow) =>
    [...filters].every(([key, value]) => (row[key] ?? null) === value);
  const run = (single: boolean) => {
    const failureKey = `${table}:${operation}`;
    const failure =
      columns === "timezone" ? undefined : readFailures.get(failureKey);
    if (failure) {
      readFailures.delete(failureKey);
      return { data: null, error: failure };
    }
    let rows: FixtureRow[];
    if (table === "patients") {
      rows = [
        {
          id: patientId,
          org_id: orgId,
          status: "active",
          phone_e164: "+15555550101",
          email: "fixture@example.test",
          legal_first_name: "Fixture",
          timezone: "America/New_York",
        },
      ];
    } else if (table === "episodes") {
      rows = [
        {
          id: episodeId,
          org_id: orgId,
          patient_id: patientId,
          prescription_id: "fixture-rx",
        },
      ];
    } else if (table === "prescriptions") {
      rows = [{ id: "fixture-rx", org_id: orgId, item_sku: "FILTER-DISP" }];
    } else if (table === "conversations" || table === "messages") {
      const stored = table === "conversations" ? conversations : messages;
      if (operation === "insert") {
        const inserted = { ...payload, id: randomUUID() };
        stored.push(inserted);
        rows = [inserted];
      } else if (operation === "update") {
        rows = stored.filter(matches);
        rows.forEach((row) => Object.assign(row, payload));
      } else if (operation === "delete") {
        rows = stored.filter(matches);
        if (table === "conversations")
          conversations = stored.filter((row) => !matches(row));
        else messages = stored.filter((row) => !matches(row));
      } else rows = stored.filter(matches);
    } else throw new Error(`Unexpected fixture table: ${table}`);
    if (operation === "select") rows = rows.filter(matches);
    return { data: single ? (rows[0] ?? null) : rows, error: null };
  };
  const query = {
    select: (value: string) => {
      columns = value;
      return query;
    },
    eq: (column: string, value: unknown) => {
      filters.set(column, value);
      return query;
    },
    is: (column: string, value: unknown) => {
      filters.set(column, value);
      return query;
    },
    limit: () => query,
    insert: (value: FixtureRow) => {
      operation = "insert";
      payload = value;
      return query;
    },
    update: (value: FixtureRow) => {
      operation = "update";
      payload = value;
      return query;
    },
    delete: () => {
      operation = "delete";
      return query;
    },
    maybeSingle: async () => run(true),
    then: <T>(resolve: (value: ReturnType<typeof run>) => T | PromiseLike<T>) =>
      Promise.resolve(run(false)).then(resolve),
  };
  return query;
}

// PostgreSQL, not a scripted conflict response, decides which claims collide.
// This catches a different channel/episode accidentally changing a patient key.
function createRaw() {
  const raw = {
    schema: () => ({
      from: (table: string) => {
        if (table !== "worker_dedup_keys") return entityQuery(table);
        return {
          insert: async (
            input:
              | { key: string; expires_at: string }
              | { key: string; expires_at: string }[],
          ) => {
            const rows = Array.isArray(input) ? input : [input];
            try {
              await database.query(
                `INSERT INTO worker_dedup_keys (key, expires_at) VALUES ${rows.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`).join(", ")}`,
                rows.flatMap((row) => [row.key, row.expires_at]),
              );
              return { error: null };
            } catch (error) {
              return { error };
            }
          },
          delete: () => {
            let keys: string[];
            let expiredAt: string | undefined;
            const query = {
              eq: (_column: string, value: string) => {
                keys = [value];
                return query;
              },
              in: (_column: string, values: string[]) => {
                keys = values;
                return query;
              },
              lte: (_column: string, value: string) => {
                expiredAt = value;
                return query;
              },
              then: <T>(
                resolve: (value: { error: null }) => T | PromiseLike<T>,
              ) =>
                database
                  .query(
                    `DELETE FROM worker_dedup_keys WHERE key = ANY($1::text[])${expiredAt ? " AND expires_at <= $2" : ""}`,
                    expiredAt ? [keys, expiredAt] : [keys],
                  )
                  .then(() => resolve({ error: null })),
            };
            return query;
          },
        };
      },
    }),
  };
  return raw as unknown as NonNullable<
    Parameters<typeof getOrgScopedClient>[1]
  >;
}
function scoped(org = orgId) {
  return getOrgScopedClient(org, createRaw());
}

type Channel = "sms" | "email" | "voice";
const queues = {
  sms: "reminders.send-sms",
  email: "reminders.send-email",
  voice: "reminders.place-call",
};
const handlers = new Map<
  string,
  (
    jobs: {
      id: string;
      data: {
        orgId: string;
        patientId: string;
        episodeId: string;
        csrRequested: boolean;
      };
    }[],
  ) => Promise<void>
>();
function dispatch(channel: Channel, cycle = episodeId, csrRequested = true) {
  return handlers.get(queues[channel])!([
    {
      id: `job-${csrRequested ? "csr" : "scheduled"}-${channel}`,
      data: { orgId, patientId, episodeId: cycle, csrRequested },
    },
  ]);
}
const nextChannel = (channel: Channel): Channel =>
  channel === "sms" ? "email" : "sms";
const providers = {
  sms: mocks.smsProvider,
  email: mocks.emailProvider,
  voice: mocks.voiceProvider,
};
async function useRealSenders() {
  const text = await vi.importActual<
    typeof import("@workspace/resupply-reminders")
  >("@workspace/resupply-reminders");
  const voice = await vi.importActual<
    typeof import("../../lib/voice/place-outbound-call")
  >("../../lib/voice/place-outbound-call");
  mocks.sms.mockImplementation(text.sendReminderSms);
  mocks.email.mockImplementation(text.sendReminderEmail);
  mocks.voice.mockImplementation(voice.placeOutboundReorderCall);
}

beforeAll(async () => {
  database = new PGlite();
  await database.waitReady;
  await database.exec(
    "CREATE TABLE worker_dedup_keys (key text PRIMARY KEY, expires_at timestamptz NOT NULL)",
  );
  const boss = {
    createQueue: vi.fn(),
    schedule: vi.fn(),
    work: (queue: string, handler: Parameters<typeof handlers.set>[1]) => {
      handlers.set(queue, handler);
    },
  } as unknown as PgBoss;
  await registerReminderJobs(boss);
  await registerReminderVoiceJob(boss);
}, 30_000);
beforeEach(() => {
  vi.clearAllMocks();
  conversations = [];
  messages = [];
  readFailures.clear();
  mocks.smsProvider.mockReset().mockResolvedValue({ messageSid: "SM-fixture" });
  mocks.emailProvider
    .mockReset()
    .mockResolvedValue({ messageId: "email-fixture" });
  mocks.voiceProvider.mockReset().mockResolvedValue({ sid: "CA-fixture" });
  mocks.pendingRegister.mockReset().mockResolvedValue(undefined);
  mocks.pendingAttach.mockReset().mockResolvedValue(true);
  vi.useFakeTimers({ now: new Date("2026-09-11T17:00:00Z"), toFake: ["Date"] });
  for (const channel of ["sms", "email", "voice"] as const)
    mocks[channel].mockReset().mockResolvedValue({
      status: "ok",
      conversationId: "conversation",
      vendorRef: "accepted",
      callSid: "accepted",
    });
  mocks.markAwaiting.mockReset().mockResolvedValue(undefined);
  mocks.company.mockReset().mockResolvedValue({ name: "Test Practice" });
  vi.stubEnv("TWILIO_ACCOUNT_SID", "test-account");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
  vi.stubEnv("TWILIO_PHONE_NUMBER", "+15555550100");
  vi.stubEnv("RESUPPLY_VOICE_PUBLIC_BASE_URL", "https://practice.example.test");
  vi.stubEnv("SENDGRID_API_KEY", "test-key");
  vi.stubEnv("SENDGRID_FROM_NAME", "Test Practice");
  vi.stubEnv(
    "RESUPPLY_LINK_HMAC_KEY",
    "fixture-signing-key-for-local-tests-only",
  );
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await database.exec("DELETE FROM worker_dedup_keys");
});
afterAll(async () => {
  await database?.close();
});

describe("CSR outreach dispatch deduplication", () => {
  it("allows only one concurrent contact across SMS, email and voice", async () => {
    const claims = await Promise.all(
      (["sms", "email", "voice"] as const).map((channel) =>
        tryClaimReminderDedupKey(
          scoped(),
          channel,
          patientId,
          episodeId,
          `job-${channel}`,
          { csrRequested: true },
        ),
      ),
    );
    expect(claims.filter((claim) => claim.proceed)).toHaveLength(1);
    vi.setSystemTime(new Date(Date.now() + 47 * 3600000));
    expect(
      (
        await tryClaimReminderDedupKey(
          scoped(),
          "email",
          patientId,
          "later-cycle",
          "later-job",
          { csrRequested: true },
        )
      ).proceed,
    ).toBe(false);
  });

  it("deduplicates different cycles for one patient and isolates tenants", async () => {
    const first = await tryClaimReminderDedupKey(
      scoped(),
      "sms",
      patientId,
      episodeId,
      "one",
      { csrRequested: true },
    );
    const second = await tryClaimReminderDedupKey(
      scoped(),
      "sms",
      patientId,
      "other-cycle",
      "two",
      { csrRequested: true },
    );
    const otherOrg = await tryClaimReminderDedupKey(
      scoped("44444444-4444-4444-8444-444444444444"),
      "sms",
      "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666",
      "three",
      { csrRequested: true },
    );
    expect(first.proceed).toBe(true);
    expect(second.proceed).toBe(false);
    expect(otherOrg.proceed).toBe(true);
  });

  it("permits another channel after a definite non-send releases its claim", async () => {
    const first = await tryClaimReminderDedupKey(
      scoped(),
      "sms",
      patientId,
      episodeId,
      "one",
      { csrRequested: true },
    );
    await releaseReminderDedupKey(scoped(), first.keys, "one");
    expect(
      (
        await tryClaimReminderDedupKey(
          scoped(),
          "email",
          patientId,
          episodeId,
          "two",
          { csrRequested: true },
        )
      ).proceed,
    ).toBe(true);
  });

  it("reclaims an expired cooldown without waiting for the daily pruning job", async () => {
    await tryClaimReminderDedupKey(
      scoped(),
      "sms",
      patientId,
      episodeId,
      "one",
      { csrRequested: true },
    );
    vi.setSystemTime(new Date(Date.now() + 49 * 3600000));
    expect(
      (
        await tryClaimReminderDedupKey(
          scoped(),
          "sms",
          patientId,
          episodeId,
          "two",
          { csrRequested: true },
        )
      ).proceed,
    ).toBe(true);
  });

  it("preserves the separate channel keys for normal automated reminders", async () => {
    const first = await tryClaimReminderDedupKey(
      scoped(),
      "sms",
      patientId,
      episodeId,
      "one",
    );
    const second = await tryClaimReminderDedupKey(
      scoped(),
      "email",
      patientId,
      episodeId,
      "two",
    );
    expect(first.proceed).toBe(true);
    expect(second.proceed).toBe(true);
  });
});

describe("CSR dispatch through real send helpers", () => {
  for (const channel of ["sms", "email", "voice"] as const) {
    it.each(["CSR first", "scheduled first", "concurrent"] as const)(
      `${channel} shares dispatch exclusion with a queued scheduled job: %s`,
      async (order) => {
        await useRealSenders();
        // Both jobs target the same cycle and were queued before either sent.
        const csr = () => dispatch(channel);
        const scheduled = () => dispatch(channel, episodeId, false);
        if (order === "concurrent") await Promise.all([csr(), scheduled()]);
        else if (order === "CSR first") {
          await csr();
          await scheduled();
        } else {
          await scheduled();
          await csr();
        }
        expect(providers[channel]).toHaveBeenCalledTimes(1);
        expect(conversations).toHaveLength(1);
        expect(messages).toHaveLength(channel === "voice" ? 0 : 1);
      },
    );

    for (const failedOperation of [
      "patients:select",
      "conversations:insert",
    ] as const) {
      it.each(["same channel", "another channel"] as const)(
        `${channel} recovers from ${failedOperation} before provider contact using %s`,
        async (retry) => {
          await useRealSenders();
          const failure = new Error(`fixture ${failedOperation} unavailable`);
          readFailures.set(failedOperation, failure);
          await expect(dispatch(channel)).rejects.toThrow(failure.message);
          expect(providers[channel]).not.toHaveBeenCalled();
          expect(conversations).toHaveLength(0);
          const retryChannel =
            retry === "same channel" ? channel : nextChannel(channel);
          await dispatch(retryChannel);
          expect(providers[retryChannel]).toHaveBeenCalledTimes(1);
          expect(conversations).toHaveLength(1);
        },
      );
    }

    it(`${channel} retains exclusion after an unknown provider failure`, async () => {
      await useRealSenders();
      providers[channel].mockRejectedValueOnce(
        new Error("fixture provider connection lost"),
      );
      await expect(dispatch(channel)).rejects.toThrow(
        "fixture provider connection lost",
      );
      expect(providers[channel]).toHaveBeenCalledTimes(1);
      await dispatch(channel);
      await dispatch(channel, episodeId, false);
      await dispatch(nextChannel(channel));
      expect(providers[channel]).toHaveBeenCalledTimes(1);
      expect(providers[nextChannel(channel)]).not.toHaveBeenCalled();
    });
  }

  it.each(["voice", "sms"] as const)(
    "recovers from a pending voice-session registration failure through %s",
    async (retryChannel) => {
      await useRealSenders();
      mocks.pendingRegister.mockRejectedValueOnce(
        new Error("fixture pending session unavailable"),
      );
      await expect(dispatch("voice")).rejects.toThrow(
        "fixture pending session unavailable",
      );
      expect(providers.voice).not.toHaveBeenCalled();
      expect(conversations[0]?.last_message_at).toBeNull();
      await dispatch(retryChannel);
      expect(providers[retryChannel]).toHaveBeenCalledTimes(1);
    },
  );

  it("a scheduled-key conflict leaves no partial patient claim blocking another CSR channel", async () => {
    await useRealSenders();
    await dispatch("sms", episodeId, false);
    await dispatch("sms");
    expect(providers.sms).toHaveBeenCalledTimes(1);
    // Eligibility is stubbed so this isolates atomic claim rollback from the
    // separate recent-contact policy: a losing claim must own no other keys.
    await dispatch("email");
    expect(providers.email).toHaveBeenCalledTimes(1);
  });
});

describe("registered CSR outreach workers", () => {
  it("sends one contact when three channel jobs run concurrently", async () => {
    await Promise.all(
      (["sms", "email", "voice"] as const).map((channel) => dispatch(channel)),
    );
    expect(
      mocks.sms.mock.calls.length +
        mocks.email.mock.calls.length +
        mocks.voice.mock.calls.length,
    ).toBe(1);
  });

  for (const channel of ["sms", "email", "voice"] as const) {
    it(`${channel} keeps its claim after accepted-send bookkeeping fails`, async () => {
      mocks.markAwaiting.mockRejectedValueOnce(
        new Error("episode write failed"),
      );
      await expect(dispatch(channel)).rejects.toThrow("episode write failed");
      await dispatch(nextChannel(channel), "another-cycle");
      expect(mocks[channel]).toHaveBeenCalledTimes(1);
      expect(mocks[nextChannel(channel)]).not.toHaveBeenCalled();
    });

    it(`${channel} keeps its claim after an unknown transport exception`, async () => {
      mocks[channel].mockRejectedValueOnce(new Error("connection lost"));
      await expect(dispatch(channel)).rejects.toThrow("connection lost");
      await dispatch(nextChannel(channel));
      expect(mocks[nextChannel(channel)]).not.toHaveBeenCalled();
    });

    for (const status of [null, 408, 429, 500]) {
      it(`${channel} ${status ?? "unknown"} provider status ${status === 429 ? "releases" : "retains"} the patient claim`, async () => {
        mocks[channel].mockResolvedValueOnce(
          channel === "voice"
            ? { status: "twilio_api_error", twilioStatus: status }
            : { status: "vendor_api_error", vendorStatus: status },
        );
        await expect(dispatch(channel)).rejects.toThrow("retryable failure");
        await dispatch(nextChannel(channel));
        expect(mocks[nextChannel(channel)]).toHaveBeenCalledTimes(
          status === 429 ? 1 : 0,
        );
      });
    }

    it(`${channel} releases a definite non-send so another channel can be used`, async () => {
      mocks[channel].mockResolvedValueOnce({
        status:
          channel === "email"
            ? "patient_missing_email"
            : "patient_missing_phone",
      });
      await dispatch(channel);
      await dispatch(nextChannel(channel));
      expect(mocks[nextChannel(channel)]).toHaveBeenCalledTimes(1);
    });
  }

  it.each(["sms", "email"] as const)(
    "%s tenant configuration failure does not claim the patient",
    async (channel) => {
      mocks.company.mockRejectedValueOnce(
        new Error("tenant configuration unavailable"),
      );
      await expect(dispatch(channel)).rejects.toThrow(
        "tenant configuration unavailable",
      );
      await dispatch(nextChannel(channel));
      expect(mocks[channel]).not.toHaveBeenCalled();
      expect(mocks[nextChannel(channel)]).toHaveBeenCalledTimes(1);
    },
  );
});

import { PGlite } from "@electric-sql/pglite";
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
}));
vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return {
    ...actual,
    getOrgScopedClient: (
      org: string,
      raw?: Parameters<typeof actual.getOrgScopedClient>[1],
    ) => actual.getOrgScopedClient(org, raw ?? createRaw()),
  };
});
vi.mock("@workspace/resupply-reminders", () => ({
  sendReminderSms: mocks.sms,
  sendReminderEmail: mocks.email,
}));
vi.mock("@workspace/resupply-secrets", () => ({ hasLinkHmacKey: () => true }));
vi.mock("../../lib/resupply/csr-outreach", () => ({
  checkCsrOutreach: async () => ({ reason: null }),
}));
vi.mock("../../lib/company-info", () => ({ getCompanyInfo: mocks.company }));
vi.mock("../../lib/messaging/tenant-telecom", () => ({
  applyTenantSmsFrom: async (_org: string, cfg: unknown) => cfg,
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
  readVoiceConfigOrNull: () => ({ twilioPhoneNumber: "+15555550100" }),
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let database: PGlite;
const patientId = "11111111-1111-4111-8111-111111111111";
const episodeId = "22222222-2222-4222-8222-222222222222";
const orgId = "33333333-3333-4333-8333-333333333333";

// PostgreSQL, not a scripted conflict response, decides which claims collide.
// This catches a different channel/episode accidentally changing a patient key.
function createRaw() {
  const raw = {
    schema: () => ({
      from: (table: string) => {
        if (table === "patients") {
          const query = {
            select: () => query,
            eq: () => query,
            limit: () => query,
            maybeSingle: async () => ({
              data: { timezone: "America/New_York" },
              error: null,
            }),
          };
          return query;
        }
        if (table !== "worker_dedup_keys") throw new Error("Unexpected table");
        return {
          insert: async (row: { key: string; expires_at: string }) => {
            try {
              await database.query(
                "INSERT INTO worker_dedup_keys (key, expires_at) VALUES ($1, $2)",
                [row.key, row.expires_at],
              );
              return { error: null };
            } catch (error) {
              return { error };
            }
          },
          delete: () => {
            let key: string;
            let expiredAt: string | undefined;
            const query = {
              eq: (_column: string, value: string) => {
                key = value;
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
                    `DELETE FROM worker_dedup_keys WHERE key = $1${expiredAt ? " AND expires_at <= $2" : ""}`,
                    expiredAt ? [key, expiredAt] : [key],
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
function dispatch(channel: Channel, cycle = episodeId) {
  return handlers.get(queues[channel])!([
    {
      id: `job-${channel}`,
      data: { orgId, patientId, episodeId: cycle, csrRequested: true },
    },
  ]);
}
const nextChannel = (channel: Channel): Channel =>
  channel === "sms" ? "email" : "sms";

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
    expect(new Set(claims.map((claim) => claim.key)).size).toBe(1);
    const stored = await database.query<{ expires_at: Date }>(
      "SELECT expires_at FROM worker_dedup_keys",
    );
    const remaining =
      new Date(stored.rows[0]!.expires_at).getTime() - Date.now();
    expect(remaining).toBeGreaterThan(47 * 3600000);
    expect(remaining).toBeLessThanOrEqual(48 * 3600000);
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
      patientId,
      episodeId,
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
    await releaseReminderDedupKey(scoped(), first.key, "one");
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
    const first = await tryClaimReminderDedupKey(
      scoped(),
      "sms",
      patientId,
      episodeId,
      "one",
      { csrRequested: true },
    );
    await database.query(
      "UPDATE worker_dedup_keys SET expires_at = $2 WHERE key = $1",
      [first.key, new Date(Date.now() - 1000).toISOString()],
    );
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
    expect(first.key).not.toBe(second.key);
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

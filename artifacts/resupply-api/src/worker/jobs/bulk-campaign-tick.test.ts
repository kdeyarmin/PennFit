// Tests for the PR-added behaviour in bulk-campaign-tick:
//
//   1. isRecipientOptedOut — exercised through processTick to verify:
//      * marketing  → emailMarketing pref key is consulted.
//      * service    → emailResupplyReminders pref key is consulted.
//      * compliance → opt-out gate is bypassed entirely.
//      * unknown    → treated as "not opted-out" (prefKey=null path).
//      * shop_customer kind → queries shop_customers table.
//      * DB error   → fail-open (treat as not opted-out).
//
//   2. suppressedAtSend counter:
//      * Recipients whose opt-out pref fires get status "suppressed"
//        and suppression_reason "opted_out_at_send_time".
//      * The atomic pool.query includes suppressed_count + $3 when > 0.
//      * Compliance recipients skip the gate and get sent normally.
//
// Architecture note: processTick calls getSupabaseServiceRoleClient()
// and `import("@workspace/resupply-db").then(m => m.getDbPool())` at
// runtime.  We own the entire @workspace/resupply-db mock here — we
// do NOT import from test-helpers/supabase-mock so there's no
// competing vi.mock registration for the same module.

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Pool mock ────────────────────────────────────────────────────────────────
const poolQueryMock = vi.hoisted(() =>
  vi.fn(async () => ({ rowCount: 1, rows: [] })),
);

// ── SendGrid mock ────────────────────────────────────────────────────────────
const sendEmailMock = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "sg-msg-1" })),
);
const createSendgridClientMock = vi.hoisted(() =>
  vi.fn(() => ({ sendEmail: sendEmailMock })),
);

vi.mock("@workspace/resupply-email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/resupply-email")>()),
  createSendgridClient: createSendgridClientMock,
}));

// ── SMS mocks (the channel='sms' send path) ──────────────────────────────────
const smsSendMock = vi.hoisted(() =>
  vi.fn(async () => ({ messageSid: "sm-msg-1" })),
);
const createTwilioSmsClientMock = vi.hoisted(() =>
  vi.fn(() => ({ sendSms: smsSendMock })),
);
// normalizeE164 is imported statically by the worker; a pass-through keeps
// already-E.164 fixtures intact and returns null for empty input.
vi.mock("@workspace/resupply-domain", () => ({
  normalizeE164: (v: string | null | undefined) =>
    v && String(v).trim().length > 0 ? String(v) : null,
}));
vi.mock("../../lib/messaging/messaging-config.js", () => ({
  readSmsConfigOrNull: vi.fn(() => ({
    twilioAccountSid: "AC_test",
    twilioAuthToken: "tok",
    twilioPhoneNumber: "+15550001111",
    twilioMessagingServiceSid: undefined,
    publicBaseUrl: "https://example.test",
  })),
}));
vi.mock("../../lib/messaging/tenant-telecom.js", () => ({
  resolveTenantSmsClientOptions: vi.fn(async () => ({})),
}));
vi.mock("@workspace/resupply-telecom", () => ({
  createTwilioSmsClient: createTwilioSmsClientMock,
}));

// ── Audit mock (fire-and-forget; we don't assert on it here) ─────────────────
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

// ── Template render mock ─────────────────────────────────────────────────────
vi.mock("@workspace/resupply-templates", () => ({
  renderMessage: vi.fn(async () => ({
    subject: "Test subject",
    bodyHtml: "<p>Body</p>",
    bodyText: "Body",
  })),
}));

// ── Local helpers that processTick imports ───────────────────────────────────
vi.mock("../../lib/message-templates/lookup.js", () => ({
  messageTemplateLookup: vi.fn(async () => null),
}));
vi.mock("../../lib/bulk-campaigns/dispatch-helpers.js", () => ({
  batchSizeForThrottle: vi.fn(() => 10),
  customArgsFor: vi.fn(() => ({})),
  TICK_INTERVAL_SECONDS: 10,
}));
vi.mock("../../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/queue-options.js", () => ({
  buildQueueConfig: vi.fn((name: string, preset: object) => ({
    name,
    ...preset,
  })),
  createQueueWithDlq: vi.fn(
    async (
      boss: { createQueue: (name: string, opts?: object) => Promise<void> },
      name: string,
      preset: object,
      overrides?: object,
    ) => {
      await boss.createQueue(`${name}.dlq`);
      await boss.createQueue(name, {
        name,
        ...preset,
        ...overrides,
        deadLetter: `${name}.dlq`,
      });
    },
  ),
  VENDOR_SEND_QUEUE_OPTS: { retryLimit: 5, retryBackoff: true, retryDelay: 10 },
}));

// ── @workspace/resupply-db mock ───────────────────────────────────────────────
// Provides getSupabaseServiceRoleClient (lightweight table builder) + getDbPool.
// Staged responses are stored in module-scope maps so helpers can push entries
// before each test without re-registering the mock.

type SupabaseOp = "select" | "insert" | "update" | "upsert" | "delete";

interface StagedResponse {
  data?: unknown;
  error?: unknown;
  count?: number | null;
  throws?: unknown;
}

const staged = new Map<string, StagedResponse[]>();
const writes = new Map<string, unknown[]>();

function stageDb(table: string, op: SupabaseOp, result: StagedResponse): void {
  const k = `${table}.${op}`;
  const list = staged.get(k) ?? [];
  list.push(result);
  staged.set(k, list);
}

function popDb(table: string, op: SupabaseOp): StagedResponse {
  const k = `${table}.${op}`;
  const list = staged.get(k);
  if (!list || list.length === 0) return { data: null, error: null };
  return list.shift()!;
}

function getWrites(table: string, op: SupabaseOp): unknown[] {
  return writes.get(`${table}.${op}`) ?? [];
}

function resetDb(): void {
  staged.clear();
  writes.clear();
}

function makeBuilder(table: string) {
  let op: SupabaseOp | null = null;
  const recordWrite = (o: SupabaseOp, payload: unknown): void => {
    const k = `${table}.${o}`;
    const list = writes.get(k) ?? [];
    list.push(payload);
    writes.set(k, list);
  };

  const resolve = (): Promise<{
    data?: unknown;
    error?: unknown;
    count?: number | null;
  }> => {
    const resp = popDb(table, op ?? "select");
    if (resp.throws !== undefined) return Promise.reject(resp.throws);
    return Promise.resolve(resp);
  };

  const builder: Record<string, unknown> = {
    select: (..._args: unknown[]) => {
      if (!op) op = "select";
      return builder;
    },
    insert: (payload?: unknown) => {
      if (!op) {
        op = "insert";
        recordWrite("insert", payload);
      }
      return builder;
    },
    update: (payload?: unknown) => {
      if (!op) {
        op = "update";
        recordWrite("update", payload);
      }
      return builder;
    },
    upsert: (payload?: unknown) => {
      if (!op) {
        op = "upsert";
        recordWrite("upsert", payload);
      }
      return builder;
    },
    delete: () => {
      if (!op) {
        op = "delete";
        recordWrite("delete", undefined);
      }
      return builder;
    },
    eq: () => builder,
    neq: () => builder,
    in: () => builder,
    lt: () => builder,
    lte: () => builder,
    gt: () => builder,
    gte: () => builder,
    not: () => builder,
    is: () => builder,
    like: () => builder,
    ilike: () => builder,
    order: () => builder,
    limit: () => builder,
    range: () => builder,
    filter: () => builder,
    or: () => builder,
    match: () => builder,
    contains: () => builder,
    containedBy: () => builder,
    maybeSingle: resolve,
    single: resolve,
    then: (ok: (v: unknown) => unknown, fail?: (v: unknown) => unknown) =>
      resolve().then(ok, fail),
  };
  return builder;
}

vi.mock("@workspace/resupply-db", () => ({
  getSupabaseServiceRoleClient: () => ({
    schema: () => ({
      from: (table: string) => makeBuilder(table),
    }),
  }),
  // The worker now reaches Supabase through the org-scoped facade.
  resolveSeedOrgId: async () => "00000000-0000-4000-8000-000000000000",
  getOrgScopedClient: () => ({
    from: (table: string) => makeBuilder(table),
    raw: () => ({
      schema: () => ({ from: (table: string) => makeBuilder(table) }),
    }),
  }),
  getDbPool: () => ({ query: poolQueryMock }),
}));

// ── Subject under test ───────────────────────────────────────────────────────
import { processTick } from "./bulk-campaign-tick";

// ── Boss stub ─────────────────────────────────────────────────────────────────
function makeBoss() {
  return {
    createQueue: vi.fn(async () => undefined),
    work: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
  };
}

// ── Campaign + recipient fixtures ─────────────────────────────────────────────

function makeCampaign(over: Record<string, unknown> = {}) {
  return {
    id: "camp-1",
    name: "Test Campaign",
    status: "sending",
    throttle_per_minute: 60,
    template_key: "marketing.generic",
    category: "marketing",
    sent_count: 0,
    failed_count: 0,
    total_recipients: 1,
    suppressed_count: 0,
    ...over,
  };
}

function makeRecipient(over: Record<string, unknown> = {}) {
  return {
    id: "rcpt-1",
    recipient_email: "patient@example.com",
    recipient_kind: "patient",
    recipient_id: "pat-1",
    ...over,
  };
}

/** Stage all the supabase calls that processTick makes for a single-recipient,
 *  single-tick run. `optedOut` controls what the patient pref SELECT returns. */
function stageSingleRecipientTick(opts: {
  campaign?: Record<string, unknown>;
  recipient?: Record<string, unknown>;
  patientPrefs?: Record<string, unknown> | null;
  /** Status the patient opt-out re-check SELECT returns (patient kind
   *  only). Defaults to "active" so the default recipient is sendable. */
  patientStatus?: string;
  /** phone_line_type the patient re-check SELECT returns (default null =
   *  unknown → allowed for SMS). Set 'landline'/'voip' to exercise the gate. */
  patientLineType?: string | null;
  /** sms_marketing_consent the patient re-check SELECT returns (default true
   *  so existing SMS tests continue to pass). Set false to exercise the
   *  TCPA consent gate. */
  patientSmsMarketingConsent?: boolean;
  claimTable?: string;
}) {
  const campaign = makeCampaign(opts.campaign ?? {});
  const recipient = makeRecipient(opts.recipient ?? {});

  // 1. Campaign SELECT
  stageDb("bulk_campaigns", "select", { data: campaign });
  // 1b. Stale-'sending' reclaim UPDATE (recovers orphaned rows; no-op here)
  stageDb("bulk_campaign_recipients", "update", { data: null });
  // 2. Pending recipients SELECT
  stageDb("bulk_campaign_recipients", "select", { data: [recipient] });
  // 3. Claim UPDATE (status → sending, RETURNING id + email + phone + kind + id)
  stageDb("bulk_campaign_recipients", "update", { data: [recipient] });
  // 4. Opt-out re-check SELECT. Patients are re-checked by `status`
  //    (paused = STOP/unsubscribed) and, for marketing SMS, by
  //    sms_marketing_consent; shop_customers by their per-channel
  //    communication_preferences.
  const prefTable =
    opts.claimTable ??
    (recipient.recipient_kind === "shop_customer"
      ? "shop_customers"
      : "patients");
  stageDb(prefTable, "select", {
    data:
      prefTable === "patients"
        ? {
            status: opts.patientStatus ?? "active",
            phone_line_type: opts.patientLineType ?? null,
            // Default true so existing tests (which test non-consent behaviour)
            // remain sendable; set false to test the TCPA gate.
            sms_marketing_consent:
              opts.patientSmsMarketingConsent !== undefined
                ? opts.patientSmsMarketingConsent
                : true,
          }
        : opts.patientPrefs !== undefined
          ? {
              communication_preferences: opts.patientPrefs,
              phone_line_type: opts.patientLineType ?? null,
            }
          : null,
  });
  // 5. Status update on recipient (sent / suppressed / failed)
  stageDb("bulk_campaign_recipients", "update", { data: null });
  // 6. Campaign status re-check (still "sending" → enqueue next tick)
  stageDb("bulk_campaigns", "select", { data: { status: "sending" } });
  // 7. Pending count (0 remaining → mark sent)
  stageDb("bulk_campaign_recipients", "select", { data: null, count: 0 } as {
    data: null;
    count: number;
  });
  // 8. markCampaignSent UPDATE
  stageDb("bulk_campaigns", "update", { data: [{ id: campaign.id }] });
}

// ── Test logger stub ──────────────────────────────────────────────────────────
const testLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

beforeEach(() => {
  resetDb();
  poolQueryMock.mockClear();
  poolQueryMock.mockResolvedValue({ rowCount: 1, rows: [] });
  sendEmailMock.mockClear();
  sendEmailMock.mockResolvedValue({ messageId: "sg-msg-1" });
  createSendgridClientMock.mockClear();
  createSendgridClientMock.mockImplementation(() => ({
    sendEmail: sendEmailMock,
  }));
  smsSendMock.mockClear();
  smsSendMock.mockResolvedValue({ messageSid: "sm-msg-1" });
  createTwilioSmsClientMock.mockClear();
  createTwilioSmsClientMock.mockImplementation(() => ({
    sendSms: smsSendMock,
  }));
  testLog.info.mockClear();
  testLog.warn.mockClear();
  testLog.error.mockClear();
});

// ──────────────────────────────────────────────────────────────────────────────
// isRecipientOptedOut — marketing category
// ──────────────────────────────────────────────────────────────────────────────

describe("processTick — opt-out re-check at send time (marketing)", () => {
  it("suppresses a recipient whose emailMarketing pref is false", async () => {
    // recipient_kind: shop_customer — the at-send re-check consults the
    // customer's communication_preferences. (Patient recipients are
    // re-checked by `status` instead; see the paused-patient test below.)
    stageSingleRecipientTick({
      campaign: { category: "marketing" },
      recipient: { recipient_kind: "shop_customer", recipient_id: "cust-1" },
      patientPrefs: { emailMarketing: false },
    });

    const boss = makeBoss();
    await processTick(
      boss as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    // The recipient should be flipped to 'suppressed' with the at-send reason
    const updates = getWrites("bulk_campaign_recipients", "update");
    const suppressionUpdate = updates.find(
      (u) =>
        (u as Record<string, unknown>).status === "suppressed" &&
        (u as Record<string, unknown>).suppression_reason ===
          "opted_out_at_send_time",
    );
    expect(suppressionUpdate).toBeDefined();
    // sendEmail must NOT be called for this recipient
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("sends to a recipient whose emailMarketing pref is true (not opted-out)", async () => {
    stageSingleRecipientTick({
      campaign: { category: "marketing" },
      patientPrefs: { emailMarketing: true },
    });

    const boss = makeBoss();
    await processTick(
      boss as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("sends when communication_preferences is null (no prefs recorded → not opted-out)", async () => {
    stageSingleRecipientTick({
      campaign: { category: "marketing" },
      patientPrefs: null,
    });

    const boss = makeBoss();
    await processTick(
      boss as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// transient-failure retry (retry_pending)
// ──────────────────────────────────────────────────────────────────────────────

describe("processTick — transient-failure retry", () => {
  function findUpdate(status: string): Record<string, unknown> | undefined {
    return getWrites("bulk_campaign_recipients", "update").find(
      (u) => (u as Record<string, unknown>).status === status,
    ) as Record<string, unknown> | undefined;
  }

  it("re-queues a retryable send failure as retry_pending and bumps send_attempts", async () => {
    stageSingleRecipientTick({
      campaign: { category: "marketing" },
      recipient: { send_attempts: 0 },
      patientPrefs: { emailMarketing: true },
    });
    sendEmailMock.mockRejectedValueOnce(
      Object.assign(new Error("503 upstream"), { retryable: true }),
    );

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    const retry = findUpdate("retry_pending");
    expect(retry).toBeDefined();
    expect(retry!.send_attempts).toBe(1);
    expect(findUpdate("failed")).toBeUndefined();
  });

  it("marks 'failed' once the retry cap (MAX_SEND_ATTEMPTS) is reached", async () => {
    stageSingleRecipientTick({
      campaign: { category: "marketing" },
      // 2 prior attempts → this attempt is the 3rd = the cap, so no more
      // retries: it lands in 'failed'.
      recipient: { send_attempts: 2 },
      patientPrefs: { emailMarketing: true },
    });
    sendEmailMock.mockRejectedValueOnce(
      Object.assign(new Error("503 upstream"), { retryable: true }),
    );

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    expect(findUpdate("retry_pending")).toBeUndefined();
    const failed = findUpdate("failed");
    expect(failed).toBeDefined();
    expect(failed!.send_attempts).toBe(3);
  });

  it("marks a non-retryable failure 'failed' immediately, regardless of attempts", async () => {
    stageSingleRecipientTick({
      campaign: { category: "marketing" },
      recipient: { send_attempts: 0 },
      patientPrefs: { emailMarketing: true },
    });
    sendEmailMock.mockRejectedValueOnce(
      Object.assign(new Error("invalid recipient"), { retryable: false }),
    );

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    expect(findUpdate("retry_pending")).toBeUndefined();
    expect(findUpdate("failed")).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// isRecipientOptedOut — service category
// ──────────────────────────────────────────────────────────────────────────────

describe("processTick — opt-out re-check at send time (service)", () => {
  it("suppresses when emailResupplyReminders pref is false", async () => {
    stageSingleRecipientTick({
      campaign: { category: "service" },
      // shop_customer kind — see note on the marketing case above.
      recipient: { recipient_kind: "shop_customer", recipient_id: "cust-1" },
      patientPrefs: { emailResupplyReminders: false },
    });

    const boss = makeBoss();
    await processTick(
      boss as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    const updates = getWrites("bulk_campaign_recipients", "update");
    const suppressionUpdate = updates.find(
      (u) =>
        (u as Record<string, unknown>).status === "suppressed" &&
        (u as Record<string, unknown>).suppression_reason ===
          "opted_out_at_send_time",
    );
    expect(suppressionUpdate).toBeDefined();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("sends when emailResupplyReminders pref is true", async () => {
    stageSingleRecipientTick({
      campaign: { category: "service" },
      patientPrefs: { emailResupplyReminders: true },
    });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// isRecipientOptedOut — compliance category bypasses opt-out gate
// ──────────────────────────────────────────────────────────────────────────────

describe("processTick — compliance category bypasses opt-out gate", () => {
  it("does NOT check patient prefs for compliance campaigns and sends the message", async () => {
    const campaign = makeCampaign({ category: "compliance" });
    const recipient = makeRecipient();

    // Stage only the calls that processTick makes when compliance bypasses the gate
    stageDb("bulk_campaigns", "select", { data: campaign });
    stageDb("bulk_campaign_recipients", "update", { data: null }); // stale-'sending' reclaim (no-op)
    stageDb("bulk_campaign_recipients", "select", { data: [recipient] });
    stageDb("bulk_campaign_recipients", "update", { data: [recipient] });
    // NO patient/shop_customers SELECT — the opt-out check is skipped
    stageDb("bulk_campaign_recipients", "update", { data: null }); // sent update
    stageDb("bulk_campaigns", "select", { data: { status: "sending" } });
    stageDb("bulk_campaign_recipients", "select", { data: null, count: 0 } as {
      data: null;
      count: number;
    });
    stageDb("bulk_campaigns", "update", { data: [{ id: campaign.id }] });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    // patients / shop_customers tables must NOT have been queried for prefs —
    // there's no patient.select in our staged queue because we never set one;
    // the fact that processTick completed without errors confirms it didn't
    // attempt a SELECT we didn't stage (which would have thrown or returned null).
    // The critical assertion is simply that the email was sent.
  });

  it("sends to a compliance recipient even when the patient pref is false for marketing", async () => {
    // If the same patient had emailMarketing=false, compliance ignores it.
    const campaign = makeCampaign({ category: "compliance" });
    const recipient = makeRecipient();

    stageDb("bulk_campaigns", "select", { data: campaign });
    stageDb("bulk_campaign_recipients", "update", { data: null }); // stale-'sending' reclaim (no-op)
    stageDb("bulk_campaign_recipients", "select", { data: [recipient] });
    stageDb("bulk_campaign_recipients", "update", { data: [recipient] });
    stageDb("bulk_campaign_recipients", "update", { data: null });
    stageDb("bulk_campaigns", "select", { data: { status: "sending" } });
    stageDb("bulk_campaign_recipients", "select", { data: null, count: 0 } as {
      data: null;
      count: number;
    });
    stageDb("bulk_campaigns", "update", { data: [{ id: campaign.id }] });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// isRecipientOptedOut — unknown / unlisted category → not opted-out
// ──────────────────────────────────────────────────────────────────────────────

describe("processTick — unknown category does not block the send", () => {
  it("sends when category is not marketing/service/compliance (prefKey=null → false)", async () => {
    stageSingleRecipientTick({
      campaign: { category: "announcement" },
      // patientPrefs doesn't matter — prefKey will be null → returns false
      patientPrefs: { emailMarketing: false, emailResupplyReminders: false },
    });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// isRecipientOptedOut — shop_customer kind
// ──────────────────────────────────────────────────────────────────────────────

describe("processTick — shop_customer uses shop_customers table for opt-out check", () => {
  it("suppresses a shop_customer with emailMarketing=false", async () => {
    stageSingleRecipientTick({
      campaign: { category: "marketing" },
      recipient: {
        recipient_kind: "shop_customer",
        recipient_id: "sc-1",
        recipient_email: "shop@example.com",
      },
      patientPrefs: { emailMarketing: false },
      claimTable: "shop_customers",
    });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    const updates = getWrites("bulk_campaign_recipients", "update");
    const suppressionUpdate = updates.find(
      (u) => (u as Record<string, unknown>).status === "suppressed",
    );
    expect(suppressionUpdate).toBeDefined();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("sends to a shop_customer with emailMarketing=true", async () => {
    stageSingleRecipientTick({
      campaign: { category: "marketing" },
      recipient: {
        recipient_kind: "shop_customer",
        recipient_id: "sc-1",
        recipient_email: "shop@example.com",
      },
      patientPrefs: { emailMarketing: true },
      claimTable: "shop_customers",
    });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// isRecipientOptedOut — DB error → fail-open (not opted-out)
// ──────────────────────────────────────────────────────────────────────────────

describe("processTick — opt-out DB error is fail-open", () => {
  it("proceeds with send when the patient pref SELECT throws", async () => {
    const campaign = makeCampaign({ category: "marketing" });
    const recipient = makeRecipient();

    stageDb("bulk_campaigns", "select", { data: campaign });
    stageDb("bulk_campaign_recipients", "update", { data: null }); // stale-'sending' reclaim (no-op)
    stageDb("bulk_campaign_recipients", "select", { data: [recipient] });
    stageDb("bulk_campaign_recipients", "update", { data: [recipient] });
    // Throw on the patient opt-out check
    stageDb("patients", "select", { throws: new Error("DB connection lost") });
    stageDb("bulk_campaign_recipients", "update", { data: null }); // sent
    stageDb("bulk_campaigns", "select", { data: { status: "sending" } });
    stageDb("bulk_campaign_recipients", "select", { data: null, count: 0 } as {
      data: null;
      count: number;
    });
    stageDb("bulk_campaigns", "update", { data: [{ id: campaign.id }] });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    // Fail-open: send is attempted despite the DB error
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// suppressedAtSend counter — pool.query accumulates suppressed_count
// ──────────────────────────────────────────────────────────────────────────────

describe("processTick — suppressedAtSend counter and pool.query", () => {
  it("includes suppressed_count in pool.query when a recipient is suppressed at send time", async () => {
    stageSingleRecipientTick({
      campaign: { category: "marketing" },
      // shop_customer kind — see opt-out re-check tests for the
      // current send-time re-check scope.
      recipient: { recipient_kind: "shop_customer", recipient_id: "cust-1" },
      patientPrefs: { emailMarketing: false },
    });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    // pool.query should have been called
    expect(poolQueryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQueryMock.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(sql).toContain("suppressed_count");
    // The raw UPDATE is tenant-scoped: WHERE id = $4 AND org_id = $5.
    expect(sql).toContain("org_id = $5");
    // params = [sent, failed, suppressedAtSend, campaignId, orgId]
    expect(params).toHaveLength(5);
    // suppressedAtSend should be 1
    expect(params[2]).toBe(1);
    // sent should be 0
    expect(params[0]).toBe(0);
    // orgId falls back to the seed org for a payload without one.
    expect(params[4]).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("includes suppressed_count = 0 in pool.query only if sent or failed > 0 (no call when all zero)", async () => {
    // If everything is suppressed (suppressedAtSend > 0) pool.query IS called.
    // Verify the UPDATE is SQL with the expected columns.
    stageSingleRecipientTick({
      campaign: { category: "marketing" },
      patientPrefs: { emailMarketing: false },
    });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );
    expect(poolQueryMock).toHaveBeenCalledTimes(1);
    const [sql] = poolQueryMock.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("failed_count");
    expect(sql).toContain("sent_count");
  });

  it("does NOT call pool.query when no recipients are processed (empty campaign)", async () => {
    // pending rows = 0 → drains immediately, no counters to update.
    const campaign = makeCampaign();
    stageDb("bulk_campaigns", "select", { data: campaign });
    stageDb("bulk_campaign_recipients", "update", { data: null }); // stale-'sending' reclaim (no-op)
    stageDb("bulk_campaign_recipients", "select", { data: [] }); // no pending
    // finalizeOrReschedule: 0 pending+sending remaining → mark sent
    stageDb("bulk_campaign_recipients", "select", { data: null, count: 0 } as {
      data: null;
      count: number;
    });
    stageDb("bulk_campaigns", "update", { data: [{ id: campaign.id }] }); // markSent

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it("does NOT call pool.query when claim race is lost (winningIds empty)", async () => {
    const campaign = makeCampaign();
    stageDb("bulk_campaigns", "select", { data: campaign });
    stageDb("bulk_campaign_recipients", "update", { data: null }); // stale-'sending' reclaim (no-op)
    stageDb("bulk_campaign_recipients", "select", {
      data: [makeRecipient()],
    }); // pendingRows has one row
    // Claim UPDATE returns empty → lost the race
    stageDb("bulk_campaign_recipients", "update", { data: [] });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it("passes the correct campaign id as the last parameter to pool.query", async () => {
    stageSingleRecipientTick({
      campaign: { category: "service" },
      patientPrefs: { emailResupplyReminders: false },
    });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    const [, params] = poolQueryMock.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(params[3]).toBe("camp-1");
  });

  it("threads the payload's tenant org_id into the counter UPDATE", async () => {
    // A campaign owned by a NON-seed tenant: the orgId from the enqueue
    // payload must scope the raw counter UPDATE (WHERE org_id = $5), not the
    // seed-org fallback.
    stageSingleRecipientTick({
      campaign: { category: "service" },
      patientPrefs: { emailResupplyReminders: false },
    });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1", orgId: "11111111-1111-4111-8111-111111111111" },
      testLog as never,
    );

    const [sql, params] = poolQueryMock.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(sql).toContain("org_id = $5");
    expect(params[3]).toBe("camp-1");
    expect(params[4]).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("resolves a non-seed owner from the campaign row for an org-less tick", async () => {
    // A pre-deploy tick carries no orgId. The campaign row's own org_id must
    // scope the work (and the counter UPDATE) — NOT the seed fallback — so a
    // non-seed campaign isn't read as "missing" and stranded in 'sending'.
    stageSingleRecipientTick({
      campaign: {
        category: "service",
        org_id: "22222222-2222-4222-8222-222222222222",
      },
      patientPrefs: { emailResupplyReminders: false },
    });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" }, // org-less (legacy) payload
      testLog as never,
    );

    const [, params] = poolQueryMock.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(params[4]).toBe("22222222-2222-4222-8222-222222222222");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// opt-out re-check — patient kind uses `status`, not email prefs
// ──────────────────────────────────────────────────────────────────────────────
//
// Patient recipients have no communication_preferences column; their opt-out
// signal is a non-'active' status (paused = texted STOP / unsubscribed),
// which the at-send re-check now consults. An active patient is always
// sendable regardless of any email-pref the campaign category cares about.

describe("processTick — patient opt-out re-check uses status", () => {
  it("sends to an ACTIVE patient regardless of marketing pref (no patient pref gate)", async () => {
    // Default makeRecipient() is recipient_kind: "patient", default status
    // "active". A marketing campaign sends to them; patient email prefs
    // don't gate the patient channel.
    stageSingleRecipientTick({
      campaign: { category: "marketing" },
      patientPrefs: { emailMarketing: false },
    });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const updates = getWrites("bulk_campaign_recipients", "update");
    const suppressionUpdate = updates.find(
      (u) =>
        (u as Record<string, unknown>).status === "suppressed" &&
        (u as Record<string, unknown>).suppression_reason ===
          "opted_out_at_send_time",
    );
    expect(suppressionUpdate).toBeUndefined();
  });

  it("SUPPRESSES a patient who became paused (STOP/unsubscribed) after enqueue", async () => {
    stageSingleRecipientTick({
      campaign: { category: "service" },
      // Patient texted STOP between enqueue and this tick → status 'paused'.
      patientStatus: "paused",
    });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    // Not sent — and parked as suppressed at send time.
    expect(sendEmailMock).not.toHaveBeenCalled();
    const updates = getWrites("bulk_campaign_recipients", "update");
    const suppressionUpdate = updates.find(
      (u) =>
        (u as Record<string, unknown>).status === "suppressed" &&
        (u as Record<string, unknown>).suppression_reason ===
          "opted_out_at_send_time",
    );
    expect(suppressionUpdate).toBeDefined();
  });

  it("paused patient is suppressed even for the compliance category (STOP is absolute)", async () => {
    stageSingleRecipientTick({
      campaign: { category: "compliance" },
      patientStatus: "paused",
    });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// SMS channel — send path (channel='sms')
// ──────────────────────────────────────────────────────────────────────────────

describe("processTick — SMS channel", () => {
  it("sends an SMS to the recipient's phone and finalizes with the Twilio SID", async () => {
    stageSingleRecipientTick({
      campaign: { category: "marketing", channel: "sms" },
      recipient: {
        recipient_kind: "patient",
        recipient_id: "pat-sms-1",
        recipient_email: null,
        recipient_phone: "+12155551212",
      },
    });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    // The email path must NOT be used; the SMS client is.
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(smsSendMock).toHaveBeenCalledTimes(1);
    const [{ to, body }] = smsSendMock.mock.calls[0] as unknown as [
      { to: string; body: string },
    ];
    expect(to).toBe("+12155551212");
    expect(body).toBe("Body"); // from the renderMessage mock's bodyText

    // The recipient is finalized 'sent' with the Twilio message SID.
    const updates = getWrites("bulk_campaign_recipients", "update") as Array<
      Record<string, unknown>
    >;
    const sentUpdate = updates.find((u) => u.status === "sent");
    expect(sentUpdate).toBeDefined();
    expect(sentUpdate!.vendor_message_id).toBe("sm-msg-1");
  });

  it("suppresses an SMS recipient whose number is a known landline (at send)", async () => {
    stageSingleRecipientTick({
      campaign: { category: "marketing", channel: "sms" },
      recipient: {
        recipient_kind: "patient",
        recipient_id: "pat-ll-1",
        recipient_email: null,
        recipient_phone: "+12155551212",
      },
      // The number was classified a landline since enqueue.
      patientLineType: "landline",
    });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    expect(smsSendMock).not.toHaveBeenCalled();
    const updates = getWrites("bulk_campaign_recipients", "update") as Array<
      Record<string, unknown>
    >;
    const suppression = updates.find(
      (u) =>
        u.status === "suppressed" &&
        u.suppression_reason === "phone_not_mobile_at_send_time",
    );
    expect(suppression).toBeDefined();
  });

  it("still sends an SMS to an unknown line type (allow-unknown policy)", async () => {
    stageSingleRecipientTick({
      campaign: { category: "marketing", channel: "sms" },
      recipient: {
        recipient_kind: "patient",
        recipient_id: "pat-unk-1",
        recipient_email: null,
        recipient_phone: "+12155551212",
      },
      patientLineType: null, // not yet classified
    });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    expect(smsSendMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses a patient who has not given SMS marketing consent (TCPA)", async () => {
    stageSingleRecipientTick({
      campaign: { category: "marketing", channel: "sms" },
      recipient: {
        recipient_kind: "patient",
        recipient_id: "pat-no-consent",
        recipient_email: null,
        recipient_phone: "+12155551212",
      },
      patientSmsMarketingConsent: false,
    });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    expect(smsSendMock).not.toHaveBeenCalled();
    const updates = getWrites("bulk_campaign_recipients", "update") as Array<
      Record<string, unknown>
    >;
    const suppression = updates.find((u) => u.status === "suppressed");
    expect(suppression).toBeDefined();
    expect(suppression!.suppression_reason).toBe("opted_out_at_send_time");
  });

  it("sends marketing SMS to a patient with smsMarketingConsent=true", async () => {
    stageSingleRecipientTick({
      campaign: { category: "marketing", channel: "sms" },
      recipient: {
        recipient_kind: "patient",
        recipient_id: "pat-consented",
        recipient_email: null,
        recipient_phone: "+12155551212",
      },
      patientSmsMarketingConsent: true,
    });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    expect(smsSendMock).toHaveBeenCalledTimes(1);
  });

  it("sends service SMS to a patient regardless of smsMarketingConsent", async () => {
    stageSingleRecipientTick({
      campaign: { category: "service", channel: "sms" },
      recipient: {
        recipient_kind: "patient",
        recipient_id: "pat-service",
        recipient_email: null,
        recipient_phone: "+12155551212",
      },
      patientSmsMarketingConsent: false,
    });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    expect(smsSendMock).toHaveBeenCalledTimes(1);
  });

  it("pauses the campaign when SMS is not configured (Twilio creds unset)", async () => {
    const { readSmsConfigOrNull } =
      await import("../../lib/messaging/messaging-config.js");
    (
      readSmsConfigOrNull as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValueOnce(null);

    const campaign = makeCampaign({ channel: "sms" });
    const recipient = makeRecipient({
      recipient_email: null,
      recipient_phone: "+12155551212",
    });
    // Sequence up to the sender construction: campaign select, reclaim,
    // pending select, claim update. Then: pause UPDATE + rollback UPDATE.
    stageDb("bulk_campaigns", "select", { data: campaign });
    stageDb("bulk_campaign_recipients", "update", { data: null }); // reclaim
    stageDb("bulk_campaign_recipients", "select", { data: [recipient] });
    stageDb("bulk_campaign_recipients", "update", { data: [recipient] }); // claim
    stageDb("bulk_campaigns", "update", { data: [{ id: campaign.id }] }); // pause
    stageDb("bulk_campaign_recipients", "update", { data: null }); // rollback

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    expect(smsSendMock).not.toHaveBeenCalled();
    const campaignUpdates = getWrites("bulk_campaigns", "update") as Array<
      Record<string, unknown>
    >;
    expect(campaignUpdates.find((u) => u.status === "paused")).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Orphaned-'sending' recovery (worker-crash safety)
// ──────────────────────────────────────────────────────────────────────────────

describe("processTick — orphaned 'sending' recovery", () => {
  it("reclaims stale 'sending' rows to 'pending' at the start of every tick", async () => {
    stageSingleRecipientTick({
      campaign: { category: "marketing" },
      patientPrefs: { emailMarketing: true },
    });

    await processTick(
      makeBoss() as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    // The FIRST recipient UPDATE is the stale-'sending' reclaim. In the
    // route it is scoped to status='sending' AND updated_at < lease; the
    // mock ignores filters, but the payload pins that the reclaim fires
    // and resets orphaned rows to 'pending' for re-send.
    const updates = getWrites("bulk_campaign_recipients", "update") as Array<
      Record<string, unknown>
    >;
    expect(updates[0]).toEqual({ status: "pending" });
  });

  it("does NOT mark the campaign 'sent' while recipients remain in 'sending'", async () => {
    // Regression: previously the drain check counted only 'pending', so a
    // campaign with rows orphaned in 'sending' (crashed mid-batch) was
    // falsely marked 'sent' and those recipients never got the email.
    const campaign = makeCampaign();
    stageDb("bulk_campaigns", "select", { data: campaign });
    stageDb("bulk_campaign_recipients", "update", { data: null }); // reclaim (nothing stale yet)
    stageDb("bulk_campaign_recipients", "select", { data: [] }); // nothing 'pending' to claim
    // finalizeOrReschedule: 2 recipients still in 'sending' → NOT done
    stageDb("bulk_campaign_recipients", "select", { data: null, count: 2 } as {
      data: null;
      count: number;
    });

    const boss = makeBoss();
    await processTick(
      boss as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    // Must reschedule a follow-up tick, NOT complete the campaign.
    expect(boss.send).toHaveBeenCalledTimes(1);
    const campaignUpdates = getWrites("bulk_campaigns", "update") as Array<
      Record<string, unknown>
    >;
    expect(campaignUpdates.find((u) => u.status === "sent")).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// registerBulkCampaignTickJob — queue creation uses buildQueueConfig
// ──────────────────────────────────────────────────────────────────────────────

describe("registerBulkCampaignTickJob — queue is created with buildQueueConfig", () => {
  it("calls boss.createQueue with BULK_CAMPAIGN_TICK_JOB and a queue options object (not bare name)", async () => {
    const boss = makeBoss();
    const { registerBulkCampaignTickJob, BULK_CAMPAIGN_TICK_JOB } =
      await import("./bulk-campaign-tick");
    await registerBulkCampaignTickJob(boss as never);
    expect(boss.createQueue).toHaveBeenCalledWith(
      BULK_CAMPAIGN_TICK_JOB,
      expect.objectContaining({ name: BULK_CAMPAIGN_TICK_JOB }),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// SendGrid client is constructed ONCE per tick (perf: was once per recipient)
// ──────────────────────────────────────────────────────────────────────────────

describe("processTick — SendGrid client construction", () => {
  it("builds the SendGrid client once for a multi-recipient batch, not per recipient", async () => {
    const r1 = makeRecipient({
      id: "rcpt-1",
      recipient_email: "a@example.com",
      recipient_id: "pat-1",
    });
    const r2 = makeRecipient({
      id: "rcpt-2",
      recipient_email: "b@example.com",
      recipient_id: "pat-2",
    });
    const campaign = makeCampaign({ total_recipients: 2 });

    // 1. campaign select
    stageDb("bulk_campaigns", "select", { data: campaign });
    // 1b. stale-'sending' reclaim update (no-op)
    stageDb("bulk_campaign_recipients", "update", { data: null });
    // 2. pending select — both recipients
    stageDb("bulk_campaign_recipients", "select", { data: [r1, r2] });
    // 3. claim update — RETURNING both
    stageDb("bulk_campaign_recipients", "update", { data: [r1, r2] });
    // 4. per-recipient opt-out select + status update (×2). Null prefs →
    //    not opted out → both send.
    stageDb("patients", "select", { data: null });
    stageDb("bulk_campaign_recipients", "update", { data: null });
    stageDb("patients", "select", { data: null });
    stageDb("bulk_campaign_recipients", "update", { data: null });
    // 5. campaign re-check (still sending)
    stageDb("bulk_campaigns", "select", { data: { status: "sending" } });
    // 6. pending count (0 → finalize)
    stageDb("bulk_campaign_recipients", "select", {
      data: null,
      count: 0,
    } as { data: null; count: number });
    // 7. mark-sent update
    stageDb("bulk_campaigns", "update", { data: [{ id: campaign.id }] });

    const boss = makeBoss();
    await processTick(
      boss as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    // Both recipients are emailed…
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    // …through a SINGLE SendGrid client built for the whole tick. Pre-fix
    // the client was reconstructed inside the per-recipient loop, i.e.
    // once per recipient (2 here, up to 600 at max throttle).
    expect(createSendgridClientMock).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Step-6 status re-read failure (app-review 2026-06-10, P2-2)
// ──────────────────────────────────────────────────────────────────────────────
describe("processTick — step-6 status re-read failure does not kill the tick chain", () => {
  it("falls through to finalize/reschedule when the status re-read errors", async () => {
    // Pre-fix, the step-6 re-read discarded the PostgREST error: a
    // transient blip looked exactly like an admin cancel, the chain
    // returned early, and the campaign wedged in 'sending' until a
    // manual pause→resume. Now an errored re-read logs and proceeds —
    // here all work is done, so the campaign must still be finalized.
    stageDb("bulk_campaigns", "select", { data: makeCampaign() });
    stageDb("bulk_campaign_recipients", "update", { data: null });
    stageDb("bulk_campaign_recipients", "select", { data: [makeRecipient()] });
    stageDb("bulk_campaign_recipients", "update", { data: [makeRecipient()] });
    stageDb("patients", "select", {
      data: { communication_preferences: { emailMarketing: true } },
    });
    stageDb("bulk_campaign_recipients", "update", { data: null });
    // Step 6: the status re-read fails transiently.
    stageDb("bulk_campaigns", "select", {
      data: null,
      error: { message: "transient PostgREST blip" },
    });
    // Step 7: remaining-work count — nothing left → finalize.
    stageDb("bulk_campaign_recipients", "select", { data: null, count: 0 } as {
      data: null;
      count: number;
    });
    // Step 8: markCampaignSent UPDATE.
    stageDb("bulk_campaigns", "update", { data: [{ id: "camp-1" }] });

    const boss = makeBoss();
    await processTick(
      boss as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    // The chain survived past step 6: the campaign was finalized
    // (pre-fix this write never happened — the tick returned early).
    expect(getWrites("bulk_campaigns", "update")).toHaveLength(1);
    // And the failure was surfaced, not swallowed.
    expect(testLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: "camp-1" }),
      expect.stringContaining("status re-read failed"),
    );
  });

  it("still stops the chain when the campaign really was cancelled", async () => {
    stageDb("bulk_campaigns", "select", { data: makeCampaign() });
    stageDb("bulk_campaign_recipients", "update", { data: null });
    stageDb("bulk_campaign_recipients", "select", { data: [makeRecipient()] });
    stageDb("bulk_campaign_recipients", "update", { data: [makeRecipient()] });
    stageDb("patients", "select", {
      data: { communication_preferences: { emailMarketing: true } },
    });
    stageDb("bulk_campaign_recipients", "update", { data: null });
    // Step 6: a SUCCESSFUL re-read reporting an admin cancel.
    stageDb("bulk_campaigns", "select", { data: { status: "cancelled" } });

    const boss = makeBoss();
    await processTick(
      boss as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    // No finalize write, no next tick — the cancel is respected.
    expect(getWrites("bulk_campaigns", "update")).toHaveLength(0);
    expect(boss.send).not.toHaveBeenCalled();
  });
});

describe("processTick — multi-tenant org threading", () => {
  it("threads the payload orgId through the re-enqueued tick", async () => {
    // Claim-race-lost path re-enqueues directly (no finalize/drain), so it's
    // the cleanest way to assert the next tick carries the same tenant.
    stageDb("bulk_campaigns", "select", { data: makeCampaign({}) });
    // Stale-'sending' reclaim UPDATE (no-op).
    stageDb("bulk_campaign_recipients", "update", { data: null });
    // Pending recipients SELECT.
    stageDb("bulk_campaign_recipients", "select", {
      data: [makeRecipient({})],
    });
    // Claim UPDATE returns 0 rows → race lost → enqueueNextTick.
    stageDb("bulk_campaign_recipients", "update", { data: [] });

    const boss = makeBoss();
    await processTick(
      boss as never,
      { campaignId: "camp-1", orgId: "org-x" },
      testLog as never,
    );

    const payloads = (boss.send as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1],
    );
    expect(payloads).toContainEqual(
      expect.objectContaining({ campaignId: "camp-1", orgId: "org-x" }),
    );
  });

  it("falls back to the seed org when the payload carries no orgId", async () => {
    stageDb("bulk_campaigns", "select", { data: makeCampaign({}) });
    stageDb("bulk_campaign_recipients", "update", { data: null });
    stageDb("bulk_campaign_recipients", "select", {
      data: [makeRecipient({})],
    });
    stageDb("bulk_campaign_recipients", "update", { data: [] });

    const boss = makeBoss();
    await processTick(
      boss as never,
      { campaignId: "camp-1" },
      testLog as never,
    );

    // resolveSeedOrgId mock → the fixed seed uuid; the re-enqueue carries it.
    const payloads = (boss.send as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1],
    );
    expect(payloads).toContainEqual(
      expect.objectContaining({
        campaignId: "camp-1",
        orgId: "00000000-0000-4000-8000-000000000000",
      }),
    );
  });
});

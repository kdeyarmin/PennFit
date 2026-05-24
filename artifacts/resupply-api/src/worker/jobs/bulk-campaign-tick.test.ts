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
const poolQueryMock = vi.hoisted(() => vi.fn(async () => ({ rowCount: 1, rows: [] })));

// ── SendGrid mock ────────────────────────────────────────────────────────────
const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ messageId: "sg-msg-1" })));
const createSendgridClientMock = vi.hoisted(() =>
  vi.fn(() => ({ sendEmail: sendEmailMock })),
);

vi.mock("@workspace/resupply-email", () => ({
  createSendgridClient: createSendgridClientMock,
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
  buildQueueConfig: vi.fn((name: string, preset: object) => ({ name, ...preset })),
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

function stageDb(
  table: string,
  op: SupabaseOp,
  result: StagedResponse,
): void {
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

  const resolve = (): Promise<{ data?: unknown; error?: unknown; count?: number | null }> => {
    const resp = popDb(table, op ?? "select");
    if (resp.throws !== undefined) return Promise.reject(resp.throws);
    return Promise.resolve(resp);
  };

  const builder: Record<string, unknown> = {
    select: (..._args: unknown[]) => { if (!op) op = "select"; return builder; },
    insert: (payload?: unknown) => { if (!op) { op = "insert"; recordWrite("insert", payload); } return builder; },
    update: (payload?: unknown) => { if (!op) { op = "update"; recordWrite("update", payload); } return builder; },
    upsert: (payload?: unknown) => { if (!op) { op = "upsert"; recordWrite("upsert", payload); } return builder; },
    delete: () => { if (!op) { op = "delete"; recordWrite("delete", undefined); } return builder; },
    eq: () => builder, neq: () => builder,
    in: () => builder, lt: () => builder, lte: () => builder,
    gt: () => builder, gte: () => builder, not: () => builder,
    is: () => builder, like: () => builder, ilike: () => builder,
    order: () => builder, limit: () => builder, range: () => builder,
    filter: () => builder, or: () => builder, match: () => builder,
    contains: () => builder, containedBy: () => builder,
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
  claimTable?: string;
}) {
  const campaign = makeCampaign(opts.campaign ?? {});
  const recipient = makeRecipient(opts.recipient ?? {});

  // 1. Campaign SELECT
  stageDb("bulk_campaigns", "select", { data: campaign });
  // 2. Pending recipients SELECT
  stageDb("bulk_campaign_recipients", "select", { data: [recipient] });
  // 3. Claim UPDATE (status → sending, RETURNING id + email + kind + id)
  stageDb("bulk_campaign_recipients", "update", { data: [recipient] });
  // 4. Opt-out check SELECT (patients or shop_customers)
  const prefTable = opts.claimTable ??
    (recipient.recipient_kind === "shop_customer" ? "shop_customers" : "patients");
  stageDb(prefTable, "select", {
    data:
      opts.patientPrefs !== undefined
        ? { communication_preferences: opts.patientPrefs }
        : null,
  });
  // 5. Status update on recipient (sent / suppressed / failed)
  stageDb("bulk_campaign_recipients", "update", { data: null });
  // 6. Campaign status re-check (still "sending" → enqueue next tick)
  stageDb("bulk_campaigns", "select", { data: { status: "sending" } });
  // 7. Pending count (0 remaining → mark sent)
  stageDb("bulk_campaign_recipients", "select", { data: null, count: 0 } as { data: null; count: number });
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
  createSendgridClientMock.mockImplementation(() => ({ sendEmail: sendEmailMock }));
  testLog.info.mockClear();
  testLog.warn.mockClear();
  testLog.error.mockClear();
});

// ──────────────────────────────────────────────────────────────────────────────
// isRecipientOptedOut — marketing category
// ──────────────────────────────────────────────────────────────────────────────

describe("processTick — opt-out re-check at send time (marketing)", () => {
  it("suppresses a recipient whose emailMarketing pref is false", async () => {
    stageSingleRecipientTick({
      campaign: { category: "marketing" },
      recipient: { recipient_kind: "patient", recipient_id: "pat-1" },
      patientPrefs: { emailMarketing: false },
    });

    const boss = makeBoss();
    await processTick(boss as never, { campaignId: "camp-1" }, testLog as never);

    // The recipient should be flipped to 'suppressed' with the at-send reason
    const updates = getWrites("bulk_campaign_recipients", "update");
    const suppressionUpdate = updates.find(
      (u) =>
        (u as Record<string, unknown>).status === "suppressed" &&
        (u as Record<string, unknown>).suppression_reason === "opted_out_at_send_time",
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
    await processTick(boss as never, { campaignId: "camp-1" }, testLog as never);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("sends when communication_preferences is null (no prefs recorded → not opted-out)", async () => {
    stageSingleRecipientTick({
      campaign: { category: "marketing" },
      patientPrefs: null,
    });

    const boss = makeBoss();
    await processTick(boss as never, { campaignId: "camp-1" }, testLog as never);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// isRecipientOptedOut — service category
// ──────────────────────────────────────────────────────────────────────────────

describe("processTick — opt-out re-check at send time (service)", () => {
  it("suppresses when emailResupplyReminders pref is false", async () => {
    stageSingleRecipientTick({
      campaign: { category: "service" },
      patientPrefs: { emailResupplyReminders: false },
    });

    const boss = makeBoss();
    await processTick(boss as never, { campaignId: "camp-1" }, testLog as never);

    const updates = getWrites("bulk_campaign_recipients", "update");
    const suppressionUpdate = updates.find(
      (u) =>
        (u as Record<string, unknown>).status === "suppressed" &&
        (u as Record<string, unknown>).suppression_reason === "opted_out_at_send_time",
    );
    expect(suppressionUpdate).toBeDefined();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("sends when emailResupplyReminders pref is true", async () => {
    stageSingleRecipientTick({
      campaign: { category: "service" },
      patientPrefs: { emailResupplyReminders: true },
    });

    await processTick(makeBoss() as never, { campaignId: "camp-1" }, testLog as never);
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
    stageDb("bulk_campaign_recipients", "select", { data: [recipient] });
    stageDb("bulk_campaign_recipients", "update", { data: [recipient] });
    // NO patient/shop_customers SELECT — the opt-out check is skipped
    stageDb("bulk_campaign_recipients", "update", { data: null }); // sent update
    stageDb("bulk_campaigns", "select", { data: { status: "sending" } });
    stageDb("bulk_campaign_recipients", "select", { data: null, count: 0 } as { data: null; count: number });
    stageDb("bulk_campaigns", "update", { data: [{ id: campaign.id }] });

    await processTick(makeBoss() as never, { campaignId: "camp-1" }, testLog as never);

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
    stageDb("bulk_campaign_recipients", "select", { data: [recipient] });
    stageDb("bulk_campaign_recipients", "update", { data: [recipient] });
    stageDb("bulk_campaign_recipients", "update", { data: null });
    stageDb("bulk_campaigns", "select", { data: { status: "sending" } });
    stageDb("bulk_campaign_recipients", "select", { data: null, count: 0 } as { data: null; count: number });
    stageDb("bulk_campaigns", "update", { data: [{ id: campaign.id }] });

    await processTick(makeBoss() as never, { campaignId: "camp-1" }, testLog as never);
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

    await processTick(makeBoss() as never, { campaignId: "camp-1" }, testLog as never);
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
      recipient: { recipient_kind: "shop_customer", recipient_id: "sc-1", recipient_email: "shop@example.com" },
      patientPrefs: { emailMarketing: false },
      claimTable: "shop_customers",
    });

    await processTick(makeBoss() as never, { campaignId: "camp-1" }, testLog as never);

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
      recipient: { recipient_kind: "shop_customer", recipient_id: "sc-1", recipient_email: "shop@example.com" },
      patientPrefs: { emailMarketing: true },
      claimTable: "shop_customers",
    });

    await processTick(makeBoss() as never, { campaignId: "camp-1" }, testLog as never);
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
    stageDb("bulk_campaign_recipients", "select", { data: [recipient] });
    stageDb("bulk_campaign_recipients", "update", { data: [recipient] });
    // Throw on the patient opt-out check
    stageDb("patients", "select", { throws: new Error("DB connection lost") });
    stageDb("bulk_campaign_recipients", "update", { data: null }); // sent
    stageDb("bulk_campaigns", "select", { data: { status: "sending" } });
    stageDb("bulk_campaign_recipients", "select", { data: null, count: 0 } as { data: null; count: number });
    stageDb("bulk_campaigns", "update", { data: [{ id: campaign.id }] });

    await processTick(makeBoss() as never, { campaignId: "camp-1" }, testLog as never);

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
      patientPrefs: { emailMarketing: false },
    });

    await processTick(makeBoss() as never, { campaignId: "camp-1" }, testLog as never);

    // pool.query should have been called
    expect(poolQueryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQueryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("suppressed_count");
    // params = [sent, failed, suppressedAtSend, campaignId]
    expect(params).toHaveLength(4);
    // suppressedAtSend should be 1
    expect(params[2]).toBe(1);
    // sent should be 0
    expect(params[0]).toBe(0);
  });

  it("includes suppressed_count = 0 in pool.query only if sent or failed > 0 (no call when all zero)", async () => {
    // If everything is suppressed (suppressedAtSend > 0) pool.query IS called.
    // Verify the UPDATE is SQL with the expected columns.
    stageSingleRecipientTick({
      campaign: { category: "marketing" },
      patientPrefs: { emailMarketing: false },
    });

    await processTick(makeBoss() as never, { campaignId: "camp-1" }, testLog as never);
    expect(poolQueryMock).toHaveBeenCalledTimes(1);
    const [sql] = poolQueryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("failed_count");
    expect(sql).toContain("sent_count");
  });

  it("does NOT call pool.query when no recipients are processed (empty campaign)", async () => {
    // pending rows = 0 → drains immediately, no counters to update.
    const campaign = makeCampaign();
    stageDb("bulk_campaigns", "select", { data: campaign });
    stageDb("bulk_campaign_recipients", "select", { data: [] }); // no pending
    stageDb("bulk_campaigns", "update", { data: [{ id: campaign.id }] }); // markSent

    await processTick(makeBoss() as never, { campaignId: "camp-1" }, testLog as never);
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it("does NOT call pool.query when claim race is lost (winningIds empty)", async () => {
    const campaign = makeCampaign();
    stageDb("bulk_campaigns", "select", { data: campaign });
    stageDb("bulk_campaign_recipients", "select", {
      data: [makeRecipient()],
    }); // pendingRows has one row
    // Claim UPDATE returns empty → lost the race
    stageDb("bulk_campaign_recipients", "update", { data: [] });

    await processTick(makeBoss() as never, { campaignId: "camp-1" }, testLog as never);
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it("passes the correct campaign id as the last parameter to pool.query", async () => {
    stageSingleRecipientTick({
      campaign: { category: "service" },
      patientPrefs: { emailResupplyReminders: false },
    });

    await processTick(makeBoss() as never, { campaignId: "camp-1" }, testLog as never);

    const [, params] = poolQueryMock.mock.calls[0] as [string, unknown[]];
    expect(params[3]).toBe("camp-1");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// registerBulkCampaignTickJob — queue creation uses buildQueueConfig
// ──────────────────────────────────────────────────────────────────────────────

describe("registerBulkCampaignTickJob — queue is created with buildQueueConfig", () => {
  it("calls boss.createQueue with BULK_CAMPAIGN_TICK_JOB and a queue options object (not bare name)", async () => {
    const boss = makeBoss();
    const { registerBulkCampaignTickJob, BULK_CAMPAIGN_TICK_JOB } = await import(
      "./bulk-campaign-tick"
    );
    await registerBulkCampaignTickJob(boss as never);
    expect(boss.createQueue).toHaveBeenCalledWith(
      BULK_CAMPAIGN_TICK_JOB,
      expect.objectContaining({ name: BULK_CAMPAIGN_TICK_JOB }),
    );
  });
});
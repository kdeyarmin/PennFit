// Focused tests for the platform-email send tick. Covers the new
// send-pipeline logic Copilot flagged as untested: campaign-state gating,
// the happy-path send→finalize, retryable vs non-retryable send failures,
// and the SendGrid-misconfig rollback+rethrow (so pg-boss retries instead
// of stranding the campaign in 'sending').
//
// Like bulk-campaign-tick.test.ts, we own the entire @workspace/resupply-db
// mock here (a lightweight staged table builder) and the SendGrid +
// dispatch-helper mocks, so processTick runs without a real DB / vendor.

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Pool mock (atomic counter UPDATE) ────────────────────────────────
const poolQueryMock = vi.hoisted(() =>
  vi.fn(async () => ({ rowCount: 1, rows: [] })),
);

// ── SendGrid mock ────────────────────────────────────────────────────
const sendEmailMock = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "sg-msg-1" })),
);
const createSendgridClientMock = vi.hoisted(() =>
  vi.fn(() => ({ sendEmail: sendEmailMock })),
);
vi.mock("@workspace/resupply-email", () => ({
  createSendgridClient: createSendgridClientMock,
}));

vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../lib/platform-outreach/dispatch.js", () => ({
  PLATFORM_EMAIL_TICK_JOB: "platform-email.send-tick",
  batchSizeForThrottle: vi.fn(() => 10),
  customArgsFor: vi.fn(() => ({})),
  buildOutreachBody: vi.fn(() => ({ html: "<p>Body</p>", text: "Body" })),
  platformPublicBaseUrl: vi.fn(() => "https://x.test"),
  unsubscribeUrlForContact: vi.fn(() => null),
  TICK_INTERVAL_SECONDS: 10,
}));

vi.mock("../lib/queue-options.js", () => ({
  createQueueWithDlq: vi.fn(async () => undefined),
  VENDOR_SEND_QUEUE_OPTS: { retryLimit: 5 },
}));

// ── @workspace/resupply-db mock ──────────────────────────────────────
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
  staged.set(k, [...(staged.get(k) ?? []), result]);
}
function popDb(table: string, op: SupabaseOp): StagedResponse {
  const list = staged.get(`${table}.${op}`);
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
    writes.set(k, [...(writes.get(k) ?? []), payload]);
  };
  const resolve = (): Promise<StagedResponse> => {
    const resp = popDb(table, op ?? "select");
    if (resp.throws !== undefined) return Promise.reject(resp.throws);
    return Promise.resolve(resp);
  };
  const builder: Record<string, unknown> = {
    select: () => {
      if (!op) op = "select";
      return builder;
    },
    insert: (p?: unknown) => {
      if (!op) {
        op = "insert";
        recordWrite("insert", p);
      }
      return builder;
    },
    update: (p?: unknown) => {
      if (!op) {
        op = "update";
        recordWrite("update", p);
      }
      return builder;
    },
    upsert: (p?: unknown) => {
      if (!op) {
        op = "upsert";
        recordWrite("upsert", p);
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
    in: () => builder,
    lt: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: resolve,
    single: resolve,
    then: (ok: (v: unknown) => unknown, fail?: (v: unknown) => unknown) =>
      resolve().then(ok, fail),
  };
  return builder;
}

vi.mock("@workspace/resupply-db", () => ({
  getSupabaseServiceRoleClient: () => ({
    schema: () => ({ from: (t: string) => makeBuilder(t) }),
  }),
  getDbPool: () => ({ query: poolQueryMock }),
}));

import { processTick } from "./platform-email-tick";

const CAMPAIGNS = "platform_email_campaigns";
const RECIPIENTS = "platform_email_recipients";
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const boss = { send: vi.fn(async () => undefined) } as never;

function stageCampaign(status: string): void {
  stageDb(CAMPAIGNS, "select", {
    data: {
      id: "camp-1",
      name: "Test",
      subject: "Hi",
      body_html: null,
      body_text: "Hi",
      status,
      throttle_per_minute: 60,
    },
  });
}
function pendingRecipient() {
  return {
    id: "rec-1",
    recipient_kind: "manual",
    recipient_ref: null,
    recipient_email: "a@b.test",
    send_attempts: 0,
  };
}

// Stage the reads common to a tick that reaches the send loop with one
// pending 'manual' recipient.
function stageThroughClaim(): void {
  stageCampaign("sending");
  stageDb(RECIPIENTS, "update", { data: [] }); // 1) stale reclaim
  stageDb(RECIPIENTS, "select", { data: [pendingRecipient()] }); // 2) pending fetch
  stageDb(RECIPIENTS, "update", { data: [pendingRecipient()] }); // 3) claim
}

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
  sendEmailMock.mockResolvedValue({ messageId: "sg-msg-1" });
  createSendgridClientMock.mockReturnValue({ sendEmail: sendEmailMock });
});

describe("platform-email tick", () => {
  it("exits without sending when the campaign isn't 'sending'", async () => {
    stageCampaign("paused");
    await processTick(boss, { campaignId: "camp-1" }, log as never);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("sends a pending recipient, finalizes it, and marks the campaign sent", async () => {
    stageThroughClaim();
    stageDb(RECIPIENTS, "update", { data: null }); // 4) finalize -> sent
    stageCampaign("sending"); // status re-read
    stageDb(RECIPIENTS, "select", { count: 0 }); // finalize: no remaining
    stageDb(CAMPAIGNS, "update", { data: [{ id: "camp-1" }] }); // markCampaignSent

    await processTick(boss, { campaignId: "camp-1" }, log as never);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(poolQueryMock).toHaveBeenCalledTimes(1); // counter accumulation
    // Campaign transitioned to 'sent'.
    const campaignUpdates = getWrites(CAMPAIGNS, "update") as Array<{
      status?: string;
    }>;
    expect(campaignUpdates.some((u) => u.status === "sent")).toBe(true);
  });

  it("rolls back the claim and RETHROWS when SendGrid is misconfigured", async () => {
    stageThroughClaim();
    createSendgridClientMock.mockImplementation(() => {
      throw new Error("SENDGRID_API_KEY missing");
    });

    await expect(
      processTick(boss, { campaignId: "camp-1" }, log as never),
    ).rejects.toThrow(/SENDGRID_API_KEY/);

    expect(sendEmailMock).not.toHaveBeenCalled();
    // The claimed batch was rolled back to 'pending' (the LAST recipient
    // update is the rollback, after the reclaim+claim updates).
    const recipientUpdates = getWrites(RECIPIENTS, "update") as Array<{
      status?: string;
    }>;
    expect(recipientUpdates.at(-1)).toEqual({ status: "pending" });
  });

  it("marks a non-retryable send failure as 'failed'", async () => {
    stageThroughClaim();
    stageDb(RECIPIENTS, "update", { data: null }); // failure-path update
    stageCampaign("sending");
    stageDb(RECIPIENTS, "select", { count: 0 });
    stageDb(CAMPAIGNS, "update", { data: [{ id: "camp-1" }] });
    sendEmailMock.mockRejectedValueOnce(
      Object.assign(new Error("hard bounce"), { retryable: false }),
    );

    await processTick(boss, { campaignId: "camp-1" }, log as never);

    const recipientUpdates = getWrites(RECIPIENTS, "update") as Array<{
      status?: string;
    }>;
    expect(recipientUpdates.some((u) => u.status === "failed")).toBe(true);
  });

  it("requeues a retryable send failure as 'retry_pending'", async () => {
    stageThroughClaim();
    stageDb(RECIPIENTS, "update", { data: null });
    stageCampaign("sending");
    stageDb(RECIPIENTS, "select", { count: 1 }); // still work remaining
    sendEmailMock.mockRejectedValueOnce(
      Object.assign(new Error("503 transient"), { retryable: true }),
    );

    await processTick(boss, { campaignId: "camp-1" }, log as never);

    const recipientUpdates = getWrites(RECIPIENTS, "update") as Array<{
      status?: string;
    }>;
    expect(recipientUpdates.some((u) => u.status === "retry_pending")).toBe(
      true,
    );
  });
});

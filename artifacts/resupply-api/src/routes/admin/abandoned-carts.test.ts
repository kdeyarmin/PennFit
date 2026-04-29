// Route tests for the cart-abandonment admin dispatcher.
//
// Same fluent-stub pattern as routes/email/send-reminder.test.ts. The
// dispatcher's hot path is now an atomic UPDATE ... RETURNING via
// `db.execute(sql\`...\`)` — we queue the {rows: [...]} payload it
// returns, then assert on the SendGrid mock + the unclaim
// `db.update(...)` invocations that fire on send failures.
//
// Coverage:
//   * atomic claim — a single db.execute SQL string contains both
//     UPDATE shop_abandoned_carts and WHERE id IN (SELECT id FROM
//     eligible), proving claims and filtering happen in one statement
//   * stamps reminded_at on success (claim sticks, no unclaim UPDATE)
//   * idempotency — zero rows returned by the claim = zero sends,
//     zero unclaims
//   * SendGrid not configured — returns sendgridConfigured:false and
//     UNCLAIMS the row so the next run can retry once env is fixed
//   * SendGrid 4xx — counts as skippedFailed and UNCLAIMS the row

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const getAuthMock = vi.fn();
const getUserMock = vi.fn();
vi.mock("@clerk/express", () => ({
  getAuth: (...a: unknown[]) => getAuthMock(...a),
  clerkClient: {
    users: { getUser: (...a: unknown[]) => getUserMock(...a) },
  },
}));

function fluent(result: unknown) {
  const obj: Record<string, unknown> = {
    from: () => obj,
    where: () => obj,
    set: () => obj,
    values: () => obj,
    orderBy: () => obj,
    leftJoin: () => obj,
    innerJoin: () => obj,
    onConflictDoUpdate: () => Promise.resolve(undefined),
    onConflictDoNothing: () => Promise.resolve(undefined),
    limit: () => Promise.resolve(result),
    returning: () => Promise.resolve(result),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}
const selectQueue: unknown[] = [];
const updateQueue: unknown[] = [];
// db.execute() now drives the dispatcher's atomic claim — it returns
// {rows, rowCount, ...} from node-postgres. Drizzle's `sql\`...\`` tag
// gets passed in here; we just queue the result payload.
const executeQueue: Array<{ rows: unknown[] }> = [];
// Last sql template-literal passed to db.execute(). Tests assert on
// the raw SQL string to prove the atomic UPDATE...RETURNING shape.
let lastExecuteSql: string | null = null;
function sqlToString(query: { queryChunks?: unknown[] }): string {
  // Drizzle's SQL object holds chunks; serialise to a plain string by
  // walking the chunks. Good enough for assertions.
  if (!query || !Array.isArray(query.queryChunks)) return String(query);
  return query.queryChunks
    .map((c) => {
      if (typeof c === "string") return c;
      if (c && typeof c === "object" && "value" in c)
        return String((c as { value: unknown }).value);
      return "";
    })
    .join("");
}
const dbStub = {
  select: vi.fn(() => fluent(selectQueue.shift() ?? [])),
  update: vi.fn(() => fluent(updateQueue.shift() ?? undefined)),
  execute: vi.fn((query: unknown) => {
    lastExecuteSql = sqlToString(query as { queryChunks?: unknown[] });
    return Promise.resolve(executeQueue.shift() ?? { rows: [] });
  }),
};
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));

vi.mock("@workspace/resupply-db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/resupply-db")>(
      "@workspace/resupply-db",
    );
  return {
    ...actual,
    getDbPool: () => ({}) as never,
  };
});

const sendEmailMock = vi.fn();
const createSendgridClientMock = vi.fn<() => { sendEmail: typeof sendEmailMock }>(
  () => ({ sendEmail: sendEmailMock }),
);
vi.mock("@workspace/resupply-email", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/resupply-email")>(
      "@workspace/resupply-email",
    );
  return {
    ...actual,
    createSendgridClient: () => createSendgridClientMock(),
  };
});

import { EmailConfigError } from "@workspace/resupply-email";

import abandonedCartsRouter from "./abandoned-carts";

const ALLOWED_EMAIL = "ops@penn.example.com";
const ROW_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROW_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", abandonedCartsRouter);
  return app;
}

function stubVerifiedAdmin(): void {
  getAuthMock.mockReturnValue({ userId: "user_op" });
  getUserMock.mockResolvedValue({
    primaryEmailAddressId: "eml_1",
    emailAddresses: [
      {
        id: "eml_1",
        emailAddress: ALLOWED_EMAIL,
        verification: { status: "verified" },
      },
    ],
  });
}

const ENV_KEYS = [
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "SENDGRID_FROM_NAME",
  "RESUPPLY_ADMIN_EMAILS",
  "SHOP_PUBLIC_BASE_URL",
  "NODE_ENV",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

function setSendgridEnv(): void {
  process.env.SENDGRID_API_KEY = "SG.testkey";
  process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
  process.env.SENDGRID_FROM_NAME = "PennPaps";
  process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
  process.env.SHOP_PUBLIC_BASE_URL = "https://test.example.com";
  process.env.NODE_ENV = "test";
}

function makeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ROW_A,
    email: "joan@example.com",
    items: [
      {
        priceId: "price_1",
        productId: "prod_1",
        name: "Headgear",
        quantity: 1,
        unitAmountCents: 4500,
        currency: "usd",
        mode: "payment",
      },
    ],
    subtotalCents: 4500,
    currency: "usd",
    ...over,
  };
}

describe("POST /admin/shop/abandoned-carts/send-due", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.NODE_ENV = "test";
    selectQueue.length = 0;
    updateQueue.length = 0;
    executeQueue.length = 0;
    lastExecuteSql = null;
    getAuthMock.mockReset();
    getUserMock.mockReset();
    sendEmailMock.mockReset();
    createSendgridClientMock.mockReset();
    createSendgridClientMock.mockImplementation(() => ({
      sendEmail: sendEmailMock,
    }));
    dbStub.select.mockClear();
    dbStub.update.mockClear();
    dbStub.execute.mockClear();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("atomically claims rows in a single UPDATE...RETURNING (no select-then-update race)", async () => {
    // This test is the architect's recommended concurrency-safety
    // assertion: prove the dispatcher uses ONE atomic statement to
    // claim and filter, not a SELECT followed by per-row UPDATEs.
    // Two concurrent invocations are race-free if and only if the
    // claim happens in this single statement.
    setSendgridEnv();
    stubVerifiedAdmin();
    executeQueue.push({ rows: [] });

    await request(makeApp())
      .post("/resupply-api/admin/shop/abandoned-carts/send-due")
      .send({});

    expect(dbStub.execute).toHaveBeenCalledTimes(1);
    expect(lastExecuteSql).not.toBeNull();
    const sqlText = lastExecuteSql ?? "";
    // Drizzle SQL column references render as opaque chunks in the
    // template-literal body; we assert on the static keywords that
    // *do* serialise in our stub. Combined, these prove the dispatcher
    // uses ONE atomic UPDATE...RETURNING, not a SELECT-then-UPDATE.

    // CTE wrapper that selects ID candidates first.
    expect(sqlText).toMatch(/WITH eligible AS\s*\(/i);
    expect(sqlText).toMatch(/SELECT id/i);
    // The four suppression-flag checks (3× IS NULL + 1× IS NOT NULL).
    // The fourth IS NULL coverage is the recovered_at flag.
    expect((sqlText.match(/\bIS NULL\b/gi) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(sqlText).toMatch(/\bIS NOT NULL\b/i);
    // Non-empty items predicate.
    expect(sqlText).toMatch(/jsonb_array_length/i);
    // Lock model: skip locked rows so two concurrent dispatcher
    // invocations don't block each other AND don't double-claim.
    expect(sqlText).toMatch(/FOR UPDATE SKIP LOCKED/i);
    // Atomic claim: UPDATE that flips reminded_at to now() in the
    // same statement that selected the rows.
    expect(sqlText).toMatch(/UPDATE/i);
    expect(sqlText).toMatch(/SET reminded_at\s*=\s*now\(\)/i);
    expect(sqlText).toMatch(/WHERE id IN \(SELECT id FROM eligible\)/i);
    // RETURNING is required so we can iterate the claimed rows.
    expect(sqlText).toMatch(/RETURNING/i);
  });

  it("delivers one email per claimed row and leaves the claim stamped", async () => {
    setSendgridEnv();
    stubVerifiedAdmin();
    executeQueue.push({
      rows: [makeRow({ id: ROW_A }), makeRow({ id: ROW_B })],
    });
    sendEmailMock.mockResolvedValue({ messageId: "SG_TEST_1" });

    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/abandoned-carts/send-due")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      scanned: 2,
      sent: 2,
      skippedNoConfig: 0,
      skippedFailed: 0,
      sendgridConfigured: true,
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    // No unclaim UPDATEs on the success path — the atomic claim from
    // db.execute() is the only stamp that needs to happen.
    expect(dbStub.update).not.toHaveBeenCalled();
    // Subject line + cart contents are public catalog data; subtotal
    // is rendered in the email body, but no PHI should be there.
    const call = sendEmailMock.mock.calls[0][0];
    expect(call.to).toBe("joan@example.com");
    expect(call.subject).toContain("PennPaps cart");
    expect(call.html).toContain("Headgear");
    expect(call.text).toContain("Headgear");
    expect(call.customArgs).toEqual({ kind: "cart_abandonment_v1" });
  });

  it("is idempotent: zero rows claimed = zero sends and zero unclaims", async () => {
    setSendgridEnv();
    stubVerifiedAdmin();
    // First invocation stamped both; second invocation finds nothing
    // because the atomic UPDATE filter excludes `reminded_at IS NOT
    // NULL`.
    executeQueue.push({ rows: [] });

    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/abandoned-carts/send-due")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      scanned: 0,
      sent: 0,
      skippedNoConfig: 0,
      skippedFailed: 0,
      sendgridConfigured: true,
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(dbStub.update).not.toHaveBeenCalled();
  });

  it("returns sendgridConfigured:false and UNCLAIMS the row when SendGrid env is missing", async () => {
    // No SENDGRID_* env — but admin auth still configured so we get
    // past requireAdmin and into the dispatcher body.
    process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
    process.env.NODE_ENV = "test";
    stubVerifiedAdmin();
    executeQueue.push({ rows: [makeRow({ id: ROW_A })] });
    // The helper catches EmailConfigError and surfaces it as
    // {configured:false}.
    createSendgridClientMock.mockImplementation(() => {
      throw new EmailConfigError("SENDGRID_API_KEY is required");
    });
    // Reserve one update slot for the unclaim.
    updateQueue.push(undefined);

    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/abandoned-carts/send-due")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      scanned: 1,
      sent: 0,
      skippedNoConfig: 1,
      skippedFailed: 0,
      sendgridConfigured: false,
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
    // Critical: we MUST unclaim the row (UPDATE setting remindedAt
    // back to NULL) when SendGrid is off, or the row would be silently
    // swallowed and never re-tried after the operator wires up env.
    expect(dbStub.update).toHaveBeenCalledTimes(1);
  });

  it("counts SendGrid 4xx/5xx as skippedFailed and UNCLAIMS the row", async () => {
    setSendgridEnv();
    stubVerifiedAdmin();
    executeQueue.push({ rows: [makeRow({ id: ROW_A })] });
    sendEmailMock.mockRejectedValue(
      Object.assign(new Error("blocked"), { name: "EmailApiError", status: 550 }),
    );
    // Reserve one update slot for the unclaim.
    updateQueue.push(undefined);

    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/abandoned-carts/send-due")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.scanned).toBe(1);
    expect(res.body.sent).toBe(0);
    expect(res.body.skippedFailed).toBe(1);
    // We tried SendGrid (configured was true), so configured stays true.
    expect(res.body.sendgridConfigured).toBe(true);
    // Row was unclaimed so the next dispatcher run can retry it.
    expect(dbStub.update).toHaveBeenCalledTimes(1);
  });
});

describe("GET /admin/shop/abandoned-carts", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.NODE_ENV = "test";
    process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
    selectQueue.length = 0;
    updateQueue.length = 0;
    getAuthMock.mockReset();
    getUserMock.mockReset();
    dbStub.select.mockClear();
    dbStub.update.mockClear();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("redacts the email and returns aggregated counts per row", async () => {
    stubVerifiedAdmin();
    const now = new Date("2026-04-29T12:00:00Z");
    selectQueue.push([
      {
        id: ROW_A,
        clerkUserId: "user_a",
        email: "joan@example.com",
        items: [
          { quantity: 2, name: "Headgear" },
          { quantity: 1, name: "Tubing" },
        ],
        subtotalCents: 12000,
        currency: "usd",
        updatedAt: now,
        remindedAt: null,
        recoveredAt: null,
        clearedAt: null,
        createdAt: now,
      },
    ]);

    const res = await request(makeApp()).get(
      "/resupply-api/admin/shop/abandoned-carts",
    );

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    const row = res.body.rows[0];
    expect(row.id).toBe(ROW_A);
    expect(row.itemCount).toBe(3);
    // Email must be partially redacted in the JSON response.
    expect(row.emailRedacted).not.toBe("joan@example.com");
    expect(row.emailRedacted).toMatch(/@example\.com$/);
    expect(row.emailRedacted.startsWith("jo")).toBe(true);
  });
});

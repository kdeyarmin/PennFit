// withIdempotency middleware unit tests.
//
// Uses an in-memory stand-in for the idempotency_keys table so we can
// exercise the lookup / replay / mismatch / expired paths without
// spinning up Postgres. The middleware reads the table via Supabase's
// `.schema("resupply").from("idempotency_keys").select(...).maybeSingle()`
// and writes via `.upsert(...)` — both go through a `getSupabaseServiceRoleClient`
// stub installed below. The stub is stateful (the upsert path in
// request A must be visible to the SELECT in request B for replay
// tests to be meaningful), so it keeps a `Map` keyed by the composite
// PK `(user_id, endpoint, key)`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";

// In-memory store keyed by `${user_id}|${endpoint}|${key}`. Holds the
// row shape PostgREST would return on a `select()` (snake_case
// columns). The middleware stores `request_hash` as a Buffer →
// `bufferToHexBytea` produces the `\x<hex>` JSON string we get back.
type StoredRow = {
  user_id: string;
  endpoint: string;
  key: string;
  request_hash: string;
  response_status: number;
  response_body: unknown;
  expires_at: string;
};
const store = new Map<string, StoredRow>();
function rowKey(userId: string, endpoint: string, key: string): string {
  return `${userId}|${endpoint}|${key}`;
}

// Builder factory. Locks the op on the first verb (matching
// supabase-js's behaviour: `update().select()` is RETURNING; the
// trailing select is decoration).
function makeBuilder() {
  let op: "select" | "upsert" | null = null;
  let pendingFilter: { user_id?: string; endpoint?: string; key?: string } = {};
  let pendingPayload: Partial<StoredRow> | null = null;

  const settle = async (): Promise<{ data: unknown; error: unknown }> => {
    if (op === "select") {
      const { user_id, endpoint, key } = pendingFilter;
      if (!user_id || !endpoint || !key) {
        return { data: null, error: null };
      }
      const row = store.get(rowKey(user_id, endpoint, key));
      return { data: row ?? null, error: null };
    }
    if (op === "upsert") {
      if (!pendingPayload) return { data: null, error: null };
      const { user_id, endpoint, key } = pendingPayload;
      if (!user_id || !endpoint || !key) {
        return {
          data: null,
          error: new Error("upsert payload missing PK columns"),
        };
      }
      // PostgREST upsert with onConflict on the composite PK behaves
      // as INSERT-or-REPLACE — store the full new payload.
      store.set(rowKey(user_id, endpoint, key), pendingPayload as StoredRow);
      return { data: null, error: null };
    }
    return { data: null, error: null };
  };

  const builder: Record<string, unknown> = {
    select: () => {
      if (op === null) op = "select";
      return builder;
    },
    upsert: (values: Partial<StoredRow>, _opts?: unknown) => {
      op = "upsert";
      pendingPayload = values;
      return builder;
    },
    eq: (col: string, val: unknown) => {
      pendingFilter = {
        ...pendingFilter,
        [col]: typeof val === "string" ? val : String(val),
      };
      return builder;
    },
    limit: () => builder,
    maybeSingle: () => settle(),
    single: () => settle(),
    then: (
      onfulfilled: (v: unknown) => unknown,
      onrejected?: (e: unknown) => unknown,
    ) => settle().then(onfulfilled, onrejected),
  };
  return builder;
}

vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return {
    ...actual,
    getSupabaseServiceRoleClient: () => ({
      schema: () => ({
        from: () => makeBuilder(),
      }),
    }),
  };
});

import { withIdempotency } from "./idempotency";

const ENDPOINT = "POST /test";

function adminInjector(req: Request, _res: Response, next: NextFunction): void {
  req.adminUserId = "user_admin";
  req.adminEmail = "admin@example.com";
  next();
}

function makeApp(handlerImpl?: (req: Request, res: Response) => void): Express {
  const app = express();
  app.use(express.json());
  app.post("/echo", adminInjector, withIdempotency(ENDPOINT), (req, res) => {
    if (handlerImpl) {
      handlerImpl(req, res);
      return;
    }
    res.status(201).json({
      id: "patient_" + Math.random().toString(36).slice(2, 8),
      echo: req.body,
    });
  });
  return app;
}

describe("withIdempotency middleware", () => {
  beforeEach(() => {
    store.clear();
  });

  it("passes through when no Idempotency-Key header is supplied", async () => {
    const app = makeApp();
    const a = await request(app).post("/echo").send({ a: 1 });
    const b = await request(app).post("/echo").send({ a: 1 });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    // Two separate handler runs → two distinct ids.
    expect(a.body.id).not.toBe(b.body.id);
    // Lookup never consulted, persistence never attempted.
    expect(store.size).toBe(0);
  });

  it("replays the stored 2xx response on a key+body match", async () => {
    let counter = 0;
    const app = makeApp((req, res) => {
      counter += 1;
      res.status(201).json({ id: `patient_${counter}`, echo: req.body });
    });
    const key = "abcdef-12345-fixed-key";
    const a = await request(app)
      .post("/echo")
      .set("Idempotency-Key", key)
      .send({ name: "Ada" });
    expect(a.status).toBe(201);
    expect(a.body).toEqual({ id: "patient_1", echo: { name: "Ada" } });

    // Allow `res.on("finish")` listener to flush the persistence upsert.
    await new Promise((r) => setImmediate(r));
    expect(store.size).toBe(1);

    const b = await request(app)
      .post("/echo")
      .set("Idempotency-Key", key)
      .send({ name: "Ada" });
    expect(b.status).toBe(201);
    expect(b.body).toEqual({ id: "patient_1", echo: { name: "Ada" } });
    // Handler ran exactly once across both calls.
    expect(counter).toBe(1);
  });

  it("returns 422 when the same key is reused with a different body", async () => {
    const app = makeApp();
    const key = "abcdef-12345-mismatch";
    const a = await request(app)
      .post("/echo")
      .set("Idempotency-Key", key)
      .send({ name: "Ada" });
    expect(a.status).toBe(201);
    await new Promise((r) => setImmediate(r));

    const b = await request(app)
      .post("/echo")
      .set("Idempotency-Key", key)
      .send({ name: "Bert" }); // different body
    expect(b.status).toBe(422);
    expect(b.body).toMatchObject({ error: "idempotency_key_reused" });
  });

  it("ignores key order when computing the body hash (stable JSON)", async () => {
    let counter = 0;
    const app = makeApp((_req, res) => {
      counter += 1;
      res.status(201).json({ id: `patient_${counter}` });
    });
    const key = "abcdef-12345-order";
    const a = await request(app)
      .post("/echo")
      .set("Idempotency-Key", key)
      .send({ a: 1, b: 2 });
    await new Promise((r) => setImmediate(r));
    const b = await request(app)
      .post("/echo")
      .set("Idempotency-Key", key)
      .send({ b: 2, a: 1 });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect(counter).toBe(1);
  });

  it("does NOT persist non-2xx responses", async () => {
    const app = makeApp((_req, res) => {
      res.status(409).json({ error: "duplicate" });
    });
    const key = "abcdef-12345-fail";
    const r = await request(app)
      .post("/echo")
      .set("Idempotency-Key", key)
      .send({ x: 1 });
    expect(r.status).toBe(409);
    await new Promise((r) => setImmediate(r));
    expect(store.size).toBe(0);
  });

  it("treats expired rows as a miss and overwrites them", async () => {
    let counter = 0;
    const app = makeApp((_req, res) => {
      counter += 1;
      res.status(201).json({ id: `patient_${counter}` });
    });
    const key = "abcdef-12345-stale";
    // Pre-seed a stale row so the first request sees it as expired.
    // request_hash is stored as the hex-bytea JSON string; an all-FFs
    // hash forces a body mismatch, and the past expires_at marks it
    // stale so the middleware falls through to the handler.
    store.set(rowKey("user_admin", ENDPOINT, key), {
      user_id: "user_admin",
      endpoint: ENDPOINT,
      key,
      request_hash: `\\x${"ff".repeat(32)}`,
      response_status: 201,
      response_body: { id: "stale_patient" },
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const r = await request(app)
      .post("/echo")
      .set("Idempotency-Key", key)
      .send({ y: 2 });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: "patient_1" });
    expect(counter).toBe(1);
    await new Promise((r) => setImmediate(r));
    // Row was overwritten in place.
    expect(store.size).toBe(1);
    const stored = store.get(rowKey("user_admin", ENDPOINT, key))!;
    expect(stored.response_body).toEqual({ id: "patient_1" });
  });

  it("rejects keys that are too short", async () => {
    const app = makeApp();
    const r = await request(app)
      .post("/echo")
      .set("Idempotency-Key", "short")
      .send({ a: 1 });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_idempotency_key");
  });

  it("replays the stored response when handler uses res.send()", async () => {
    let counter = 0;
    const app = makeApp((_req, res) => {
      counter += 1;
      res
        .status(200)
        .type("application/json")
        .send(JSON.stringify({ id: `patient_${counter}`, via: "send" }));
    });
    const key = "abcdef-12345-send-path";
    const a = await request(app)
      .post("/echo")
      .set("Idempotency-Key", key)
      .send({ name: "Ada" });
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ id: "patient_1", via: "send" });

    await new Promise((r) => setImmediate(r));
    expect(store.size).toBe(1);

    const b = await request(app)
      .post("/echo")
      .set("Idempotency-Key", key)
      .send({ name: "Ada" });
    expect(b.status).toBe(200);
    expect(b.body).toEqual({ id: "patient_1", via: "send" });
    // Handler ran exactly once across both calls.
    expect(counter).toBe(1);
  });

  it("captures and replays empty responses written via res.end()", async () => {
    let counter = 0;
    const app = makeApp((_req, res) => {
      counter += 1;
      res.statusCode = 200;
      res.end();
    });
    const key = "abcdef-12345-end-path";
    const a = await request(app)
      .post("/echo")
      .set("Idempotency-Key", key)
      .send({ z: 9 });
    expect(a.status).toBe(200);

    await new Promise((r) => setImmediate(r));
    expect(store.size).toBe(1);
    const stored = store.get(rowKey("user_admin", ENDPOINT, key))!;
    expect(stored.response_body).toBeNull();

    const b = await request(app)
      .post("/echo")
      .set("Idempotency-Key", key)
      .send({ z: 9 });
    expect(b.status).toBe(200);
    // Handler ran exactly once across both calls.
    expect(counter).toBe(1);
  });

  it("returns 500 if mounted before an admin middleware (fail-loud wiring check)", async () => {
    // Build the app WITHOUT adminInjector to simulate the misconfig.
    const app = express();
    app.use(express.json());
    app.post("/oops", withIdempotency(ENDPOINT), (_req, res) => {
      res.status(201).json({ ok: true });
    });
    const r = await request(app)
      .post("/oops")
      .set("Idempotency-Key", "abcdef-12345-misconfig")
      .send({});
    expect(r.status).toBe(500);
    expect(r.body.error).toBe("idempotency_misconfigured");
  });

  it("replays the stored response when handler responds via res.send() with a JSON string", async () => {
    // Covers the patchedSend capture path: handlers that call res.send()
    // directly (e.g. with a pre-serialised JSON string) must also be
    // captured so a retry does not re-execute the handler.
    let counter = 0;
    const app = makeApp((_req, res) => {
      counter += 1;
      res
        .status(201)
        .send(
          JSON.stringify({ id: `patient_send_${counter}`, source: "send" }),
        );
    });
    const key = "abcdef-12345-send-json";

    const a = await request(app)
      .post("/echo")
      .set("Idempotency-Key", key)
      .send({ v: 1 });
    expect(a.status).toBe(201);
    // Express sets text/html for res.send(str); check raw text, not parsed body.
    expect(a.text).toContain("patient_send_1");

    // Flush the finish listener so the persistence upsert runs.
    await new Promise((r) => setImmediate(r));
    expect(store.size).toBe(1);
    // The middleware JSON.parses the string body before storing it.
    const stored = store.get(rowKey("user_admin", ENDPOINT, key))!;
    expect(stored.response_body).toEqual({
      id: "patient_send_1",
      source: "send",
    });

    const b = await request(app)
      .post("/echo")
      .set("Idempotency-Key", key)
      .send({ v: 1 });
    expect(b.status).toBe(201);
    // Replay goes through res.json(), so Content-Type: application/json
    // and the body is the stored parsed object.
    expect(b.body).toEqual({ id: "patient_send_1", source: "send" });
    // Handler must NOT have been invoked a second time.
    expect(counter).toBe(1);
  });

  it("replays the stored response when handler responds via res.end() (empty body)", async () => {
    // Covers the patchedEnd capture path: handlers that call res.end()
    // without going through res.json() or res.send() (e.g. 204 No-Content
    // patterns) must still be captured so retries are idempotent.
    let counter = 0;
    const app = makeApp((_req, res) => {
      counter += 1;
      res.status(200).end();
    });
    const key = "abcdef-12345-end-empty";

    const a = await request(app)
      .post("/echo")
      .set("Idempotency-Key", key)
      .send({});
    expect(a.status).toBe(200);

    await new Promise((r) => setImmediate(r));
    expect(store.size).toBe(1);
    const stored = store.get(rowKey("user_admin", ENDPOINT, key))!;
    // res.end() with no prior capture stores null as the body.
    expect(stored.response_body).toBeNull();
    expect(stored.response_status).toBe(200);

    const b = await request(app)
      .post("/echo")
      .set("Idempotency-Key", key)
      .send({});
    expect(b.status).toBe(200);
    // Handler must NOT have been invoked a second time.
    expect(counter).toBe(1);
  });
});

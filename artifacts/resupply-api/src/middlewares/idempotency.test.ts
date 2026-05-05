// withIdempotency middleware unit tests.
//
// These tests use an in-memory stand-in for the idempotency_keys
// table so we can exercise the lookup / replay / mismatch / expired
// paths without spinning up Postgres. The middleware reads the table
// via `drizzle(getDbPool()).select()` and writes via `.insert()` —
// both go through the `db` shape that we mock here. The same shape
// is used by the existing patients/list.test.ts so this pattern is
// familiar.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";

// In-memory store shared across the mocked db calls within one test.
type StoredRow = {
  userId: string;
  endpoint: string;
  key: string;
  requestHash: Buffer;
  responseStatus: number;
  responseBody: unknown;
  expiresAt: Date;
};
let store: StoredRow[] = [];
// Pending filter state captured by select().from().where(...) so the
// fluent terminal call can apply it.
let selectFilter: ((row: StoredRow) => boolean) | null = null;
// Holds the last where()-filter object for an UPDATE-style call. We
// don't need it for these tests since onConflictDoUpdate handles
// upserts, but the var keeps the fluent shape symmetric.

function fluentSelect(rows: StoredRow[]): unknown {
  const obj: Record<string, unknown> = {
    from: () => obj,
    where: (predicate: unknown) => {
      // The middleware passes a Drizzle SQL object built from
      // `and(eq(...), eq(...), eq(...))`. We don't try to introspect
      // that — the test stub's `eq`/`and` mocks (below) capture the
      // expected (userId, endpoint, key) tuple in `selectFilter`
      // for us.
      void predicate;
      return obj;
    },
    limit: () => obj,
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(selectFilter ? rows.filter(selectFilter) : rows).then(
        (filtered) => {
          selectFilter = null;
          return resolve(filtered);
        },
        reject,
      ),
  };
  return obj;
}

function fluentInsert(): unknown {
  let pendingValues: Partial<StoredRow> | null = null;
  let upsert = false;
  let upsertSet: Partial<StoredRow> | null = null;
  const obj: Record<string, unknown> = {
    values: (v: Partial<StoredRow>) => {
      pendingValues = v;
      return obj;
    },
    onConflictDoUpdate: (cfg: { set: Partial<StoredRow> }) => {
      upsert = true;
      upsertSet = cfg.set;
      return obj;
    },
    then: (
      resolve: (v: unknown) => unknown,
      reject: (e: unknown) => unknown,
    ) => {
      try {
        if (!pendingValues) throw new Error("insert without values");
        const idx = store.findIndex(
          (r) =>
            r.userId === pendingValues!.userId &&
            r.endpoint === pendingValues!.endpoint &&
            r.key === pendingValues!.key,
        );
        if (idx >= 0) {
          if (upsert) {
            store[idx] = {
              ...store[idx],
              ...(upsertSet as Partial<StoredRow>),
              userId: store[idx].userId,
              endpoint: store[idx].endpoint,
              key: store[idx].key,
            };
          }
          // No-op without onConflictDoUpdate.
        } else {
          store.push({
            userId: pendingValues.userId!,
            endpoint: pendingValues.endpoint!,
            key: pendingValues.key!,
            requestHash: pendingValues.requestHash!,
            responseStatus: pendingValues.responseStatus!,
            responseBody: pendingValues.responseBody,
            expiresAt: pendingValues.expiresAt!,
          });
        }
        return Promise.resolve(undefined).then(resolve, reject);
      } catch (err) {
        return Promise.resolve(undefined).then(() => reject(err));
      }
    },
  };
  return obj;
}

const dbStub = {
  select: vi.fn(() => fluentSelect(store)),
  insert: vi.fn(() => fluentInsert()),
};

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));

// Mock the eq() and and() helpers used by the middleware so we can
// derive the (userId, endpoint, key) filter from the call args.
// Drizzle's actual `and` returns an opaque SQL object; we replace it
// with a plain function that captures the filter.
vi.mock("drizzle-orm", async () => {
  const actual =
    await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  const eqMock = (col: { name?: string } | unknown, val: unknown) => ({
    __eq: true,
    col: (col as { name?: string }).name ?? String(col),
    val,
  });
  const andMock = (...preds: Array<{ col?: string; val?: unknown }>) => {
    selectFilter = (row: StoredRow) => {
      const lookup: Record<string, unknown> = {
        user_id: row.userId,
        endpoint: row.endpoint,
        key: row.key,
      };
      return preds.every((p) => {
        if (!p || typeof p !== "object" || p.col === undefined) return true;
        return lookup[p.col as string] === p.val;
      });
    };
    return { __and: true };
  };
  return {
    ...actual,
    eq: eqMock,
    and: andMock,
  };
});

vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return {
    ...actual,
    getDbPool: () => ({}) as never,
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
    store = [];
    selectFilter = null;
    dbStub.select.mockClear();
    dbStub.insert.mockClear();
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
    expect(dbStub.select).not.toHaveBeenCalled();
    expect(dbStub.insert).not.toHaveBeenCalled();
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

    // Allow `res.on("finish")` listener to flush the persistence insert.
    await new Promise((r) => setImmediate(r));
    expect(store).toHaveLength(1);

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
    expect(store).toHaveLength(0);
  });

  it("treats expired rows as a miss and overwrites them", async () => {
    let counter = 0;
    const app = makeApp((_req, res) => {
      counter += 1;
      res.status(201).json({ id: `patient_${counter}` });
    });
    const key = "abcdef-12345-stale";
    // Pre-seed a stale row so the first request sees it as expired.
    store.push({
      userId: "user_admin",
      endpoint: ENDPOINT,
      key,
      requestHash: Buffer.alloc(32, 0xff),
      responseStatus: 201,
      responseBody: { id: "stale_patient" },
      expiresAt: new Date(Date.now() - 1000),
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
    expect(store).toHaveLength(1);
    expect(store[0].responseBody).toEqual({ id: "patient_1" });
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
    expect(store).toHaveLength(1);

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
    expect(store).toHaveLength(1);
    expect(store[0]!.responseBody).toBeNull();

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
    // Note: res.send(str) makes Express set Content-Type: text/html, so
    // supertest parses the original response as text. The stored body is
    // the JSON.parsed object. The replay comes back via res.json() with
    // Content-Type: application/json so supertest parses it correctly.
    let counter = 0;
    const app = makeApp((_req, res) => {
      counter += 1;
      res
        .status(201)
        .send(JSON.stringify({ id: `patient_send_${counter}`, source: "send" }));
    });
    const key = "abcdef-12345-send-path";

    const a = await request(app)
      .post("/echo")
      .set("Idempotency-Key", key)
      .send({ v: 1 });
    expect(a.status).toBe(201);
    // Express sets text/html for res.send(str); check raw text, not parsed body.
    expect(a.text).toContain("patient_send_1");

    // Flush the finish listener so the persistence insert runs.
    await new Promise((r) => setImmediate(r));
    expect(store).toHaveLength(1);
    // The middleware JSON.parses the string body before storing it.
    expect(store[0].responseBody).toEqual({
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
    const key = "abcdef-12345-end-path";

    const a = await request(app)
      .post("/echo")
      .set("Idempotency-Key", key)
      .send({});
    expect(a.status).toBe(200);

    await new Promise((r) => setImmediate(r));
    expect(store).toHaveLength(1);
    // res.end() with no prior capture stores null as the body.
    expect(store[0].responseBody).toBeNull();
    expect(store[0].responseStatus).toBe(200);

    const b = await request(app)
      .post("/echo")
      .set("Idempotency-Key", key)
      .send({});
    expect(b.status).toBe(200);
    // Handler must NOT have been invoked a second time.
    expect(counter).toBe(1);
  });
});

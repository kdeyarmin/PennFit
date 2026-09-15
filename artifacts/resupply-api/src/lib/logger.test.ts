import { describe, expect, it } from "vitest";
import pino from "pino";

import { LOG_REDACT_PATHS, LOG_SERIALIZERS } from "./logger";

/**
 * pino applies a redaction path only if it matches; a typo (`req.bodyy`)
 * is silently a no-op. So the config in `logger.ts` is worth exactly as
 * much as the assertions here.
 *
 * These build a fresh pino over the same config rather than importing
 * the shared `logger`, which in tests writes through the pino-pretty
 * transport (a worker thread) and can't be captured synchronously.
 */
function logLine(
  payload: Record<string, unknown>,
  { serialize = true }: { serialize?: boolean } = {},
): Record<string, unknown> {
  const chunks: string[] = [];
  const log = pino(
    {
      redact: [...LOG_REDACT_PATHS],
      // Opting out isolates the redaction paths, which are the second
      // line of defense behind the allowlist: with serializers on, the
      // allowlist drops `req.body` before redaction is ever consulted,
      // so a broken path would pass unnoticed.
      ...(serialize ? { serializers: LOG_SERIALIZERS } : {}),
      base: null,
      timestamp: false,
    },
    { write: (chunk: string) => chunks.push(chunk) } as never,
  );
  log.info(payload, "test");
  return JSON.parse(chunks.join("")) as Record<string, unknown>;
}

const REDACTED = "[Redacted]";

/** The shape a stray `logger.warn({ req }, …)` produces on POST /api/orders. */
function orderRequest() {
  return {
    req: {
      method: "POST",
      url: "/api/orders?email=patient%40example.com",
      headers: {
        authorization: "Bearer super-secret-token",
        cookie: "pf_session=abc123; pf_csrf=def456",
        host: "pennpaps.com",
      },
      query: { email: "patient@example.com" },
      body: {
        patientName: "Jane Doe",
        dateOfBirth: "1970-01-01",
        insuranceMemberId: "ABC123456",
        address: { line1: "12 Elm St", city: "Philadelphia" },
      },
    },
  };
}

describe("logger request serialization", () => {
  it("drops the body, headers and query of a logged request — order payloads are PHI", () => {
    const line = logLine(orderRequest());

    const req = line.req as Record<string, unknown>;
    expect(req.body).toBeUndefined();
    expect(req.headers).toBeUndefined();
    expect(req.query).toBeUndefined();

    const serialized = JSON.stringify(line);
    for (const secret of [
      "Jane Doe",
      "1970-01-01",
      "ABC123456",
      "12 Elm St",
      "Philadelphia",
      "super-secret-token",
      "pf_session=abc123",
    ]) {
      expect(serialized, `leaked: ${secret}`).not.toContain(secret);
    }
  });

  it("strips the query string from the URL, which hides PHI a plaintext grep would miss", () => {
    const line = logLine(orderRequest());

    // The encoded form is the trap: `?email=patient%40example.com`
    // does not contain the plaintext address, so a log scan for
    // "patient@example.com" comes back clean while the value is there.
    expect((line.req as Record<string, unknown>).url).toBe("/api/orders");
    expect(JSON.stringify(line)).not.toContain("patient%40example.com");
  });

  it("keeps method and URL path, so dropping the rest does not cost the line its meaning", () => {
    const line = logLine(orderRequest());

    const req = line.req as Record<string, unknown>;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/api/orders");
  });

  it("keeps a response's status code and drops its headers, so Set-Cookie cannot land in a log", () => {
    const line = logLine({
      res: {
        statusCode: 200,
        headers: { "set-cookie": ["pf_session=abc123; HttpOnly"] },
      },
    });

    const res = line.res as Record<string, unknown>;
    expect(res.statusCode).toBe(200);
    expect(res.headers).toBeUndefined();
    expect(JSON.stringify(line)).not.toContain("pf_session=abc123");
  });
});

describe("logger redaction", () => {
  it("redacts a request body even when the serializer allowlist is bypassed", () => {
    // A child logger can override `serializers`; the redaction paths are
    // what still holds if one does. Without this, the allowlist would be
    // a single point of failure.
    const line = logLine(orderRequest(), { serialize: false });

    const req = line.req as Record<string, unknown>;
    expect(req.body).toBe(REDACTED);
    expect(req.headers).toBe(REDACTED);
    expect(req.query).toBe(REDACTED);
    expect(JSON.stringify(line)).not.toContain("Jane Doe");
    expect(JSON.stringify(line)).not.toContain("super-secret-token");
  });

  it("redacts the error fields that echo the offending row, keeping the code that makes the failure diagnosable", () => {
    // A PostgREST error is a plain object, not an Error — this is the
    // exact shape `errorHandler` logs, and pino's err serializer keeps
    // arbitrary extra keys, so the paths have to cover it.
    const line = logLine({
      err: {
        code: "23505",
        message: "duplicate key value violates unique constraint",
        detail: "Failing row contains (Jane Doe, 1970-01-01)",
        details: "Key (email)=(patient@example.com) already exists",
        hint: "connect to db-host.internal",
      },
    });

    const logged = line.err as Record<string, unknown>;
    expect(logged.message).toBe(REDACTED);
    expect(logged.detail).toBe(REDACTED);
    expect(logged.details).toBe(REDACTED);
    expect(logged.hint).toBe(REDACTED);
    expect(JSON.stringify(line)).not.toContain("Jane Doe");
    expect(JSON.stringify(line)).not.toContain("patient@example.com");
    expect(JSON.stringify(line)).not.toContain("db-host.internal");
    // The SQLSTATE / PostgREST code is the one field worth keeping: it
    // names the failure class without naming the row.
    expect(logged.code).toBe("23505");
  });

  it("redacts a cause chain even though pino folds it into the message and stack", () => {
    // pino's default err serializer collapses `cause` — the message
    // becomes "outer: inner", the stack gains a "caused by:" section,
    // and the cause's own fields are dropped. So the `err.cause.*`
    // paths never match here; what protects the cause is that the
    // fields it folds INTO are themselves redacted. This pins that,
    // because the day the fold changes those paths stop being spare.
    const line = logLine({
      err: Object.assign(new Error("outer boom"), {
        cause: Object.assign(new Error("inner boom"), {
          details: "Key (email)=(patient@example.com) already exists",
        }),
      }),
    });

    const logged = line.err as Record<string, unknown>;
    expect(logged.cause).toBeUndefined();
    expect(logged.message).toBe(REDACTED);
    expect(logged.stack).toBe(REDACTED);
    const serialized = JSON.stringify(line);
    expect(serialized).not.toContain("inner boom");
    expect(serialized).not.toContain("patient@example.com");
  });

  it("leaves operational fields alone — redaction must not cost the signal a log exists for", () => {
    // `to` here is a staff alert recipient, not a patient: which address
    // bounced is the whole point of the line. Guards against someone
    // "hardening" this into a field-name blocklist.
    const line = logLine({
      event: "low_stock_alert_send_failed",
      to: "warehouse@tenant.example",
      orgId: "00000000-0000-4000-8000-000000000001",
      sku: "F20-M",
    });

    expect(line.event).toBe("low_stock_alert_send_failed");
    expect(line.to).toBe("warehouse@tenant.example");
    expect(line.orgId).toBe("00000000-0000-4000-8000-000000000001");
    expect(line.sku).toBe("F20-M");
  });

  it("keeps every configured path applicable, so none is a silent typo", () => {
    // Build the nested object each path addresses, log it, and require
    // the value to come back redacted. A path pino never matches (a
    // typo, or a field that moved) fails here rather than going quiet.
    //
    // `err.cause.*` is excluded on purpose: pino's default serializer
    // folds the cause away, so those paths cannot match by construction.
    // The test above covers that case instead.
    const applicable = LOG_REDACT_PATHS.filter(
      (path) => !path.startsWith("err.cause."),
    );
    expect(applicable.length).toBeGreaterThan(0);

    for (const path of applicable) {
      const segments = path.split(".");
      const payload: Record<string, unknown> = {};
      let cursor = payload;
      segments.forEach((segment, index) => {
        if (index === segments.length - 1) {
          cursor[segment] = "sentinel-value";
          return;
        }
        const next: Record<string, unknown> = {};
        cursor[segment] = next;
        cursor = next;
      });

      const line = logLine(payload, { serialize: false });
      expect(JSON.stringify(line), `path not applied: ${path}`).not.toContain(
        "sentinel-value",
      );
    }
  });
});

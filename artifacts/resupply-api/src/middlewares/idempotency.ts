// withIdempotency(endpoint) — replay-safe wrapper for write routes.
//
// Contract:
//   * No `Idempotency-Key` request header → pass-through, no
//     persistence, no overhead. Endpoints work exactly as before
//     for callers that don't opt in.
//   * Header present + no stored row → run the handler, then
//     persist the response (status + body) under
//     (admin_user_id, endpoint, key) on `res.on("finish")`. The
//     column name is preserved verbatim from the original schema
//     for back-compat; today it stores the in-house
//     auth.users.id of the calling admin.
//   * Header present + stored row + matching `request_hash` → replay
//     the stored response without invoking the handler.
//   * Header present + stored row + DIFFERENT `request_hash` → 422
//     `idempotency_key_reused` to surface the client bug loudly.
//   * Stored row past `expires_at` → treat as miss, run the handler,
//     overwrite the expired row via ON CONFLICT DO UPDATE.
//
// Persistence rules:
//   * Only 2xx responses are persisted. Replaying a 4xx/5xx would
//     lock the caller out of fixing a typo by retrying with a
//     corrected body under the same key — and the second-system-of-
//     record we're protecting (created patient row, sent SMS) only
//     exists when the handler succeeded anyway.
//   * The handler runs OUTSIDE any transaction this middleware
//     opens. We never roll back the handler's writes if the audit /
//     persistence path fails — losing the replay record is strictly
//     less bad than losing the side-effect the admin already saw a
//     success for.
//
// PHI:
//   * `request_hash` is sha256(stableJson(body)); the body itself
//     never lands in this table.
//   * `response_body` IS persisted as-is. None of the wired endpoints
//     return PHI in their success bodies (they return ids, counts,
//     vendor refs). If a future caller wires this onto an endpoint
//     whose 2xx body contains PHI, that's a bug to catch before
//     wiring, not here.
//
// Why we MUST mount this AFTER requireAdmin:
//   The composite PK includes `user_id`, sourced from
//   `req.adminUserId`. requireAdmin populates that field. Mounting
//   this before requireAdmin would route every anonymous attempt
//   through a 500 — fail loudly so the wiring bug is obvious.

import crypto from "node:crypto";

import type { NextFunction, Request, Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import { getDbPool, idempotencyKeys } from "@workspace/resupply-db";

import { logger } from "../lib/logger";

// 24h TTL: long enough that "did my last POST succeed?" works after
// an overnight outage, short enough that the table doesn't grow
// without bound between prune cycles.
const TTL_MS = 24 * 60 * 60 * 1000;

const MIN_KEY_LEN = 8;
const MAX_KEY_LEN = 200;

/**
 * Stable JSON: sorts object keys at every depth so two semantically-
 * equivalent bodies hash to the same digest regardless of key order.
 * Arrays preserve order (order is semantically meaningful in arrays).
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

function hashBody(body: unknown): Buffer {
  const stable = stableStringify(body ?? null) ?? "null";
  return crypto.createHash("sha256").update(stable).digest();
}

function timingSafeBufferEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function withIdempotency(endpoint: string) {
  return async function idempotencyMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const headerKey = req.header("idempotency-key");
    if (!headerKey) {
      // Backward-compatible: callers that don't supply a key see
      // exactly the prior behavior.
      next();
      return;
    }

    const trimmed = headerKey.trim();
    if (trimmed.length < MIN_KEY_LEN || trimmed.length > MAX_KEY_LEN) {
      res.status(400).json({
        error: "invalid_idempotency_key",
        message: `Idempotency-Key header must be ${MIN_KEY_LEN}-${MAX_KEY_LEN} characters.`,
      });
      return;
    }

    const userId = req.adminUserId;
    if (!userId) {
      // Wiring bug: idempotency middleware mounted before requireAdmin.
      // Fail loud so the misconfiguration is obvious in dev.
      logger.error(
        { endpoint },
        "withIdempotency: req.adminUserId is unset. " +
          "Did you mount this middleware before requireAdmin?",
      );
      res.status(500).json({
        error: "idempotency_misconfigured",
        message:
          "Idempotency middleware was invoked without an authenticated admin.",
      });
      return;
    }

    const requestHash = hashBody(req.body);
    const db = drizzle(getDbPool());

    let existing: typeof idempotencyKeys.$inferSelect | undefined;
    try {
      const rows = await db
        .select()
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.userId, userId),
            eq(idempotencyKeys.endpoint, endpoint),
            eq(idempotencyKeys.key, trimmed),
          ),
        )
        .limit(1);
      existing = rows[0];
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
          endpoint,
        },
        "withIdempotency: lookup query failed",
      );
      res.status(500).json({
        error: "idempotency_lookup_failed",
        message: "Could not check idempotency key. Please try again.",
      });
      return;
    }

    if (existing) {
      const isLive = existing.expiresAt.getTime() > Date.now();
      if (isLive) {
        const storedHash = Buffer.isBuffer(existing.requestHash)
          ? existing.requestHash
          : Buffer.from(existing.requestHash as Uint8Array);
        if (!timingSafeBufferEqual(storedHash, requestHash)) {
          res.status(422).json({
            error: "idempotency_key_reused",
            message:
              "This Idempotency-Key was already used with a different request body. " +
              "Use a fresh key for a different request.",
          });
          return;
        }
        // Replay the stored response byte-for-byte.
        res.status(existing.responseStatus).json(existing.responseBody);
        return;
      }
      // Expired — fall through, run handler, ON CONFLICT DO UPDATE
      // will overwrite the stale row when we persist the new response.
    }

    // Capture the response so we can persist it on `finish`.
    // We patch res.json (primary path for all wired endpoints),
    // res.send (fallback for routes that return non-JSON), and
    // res.end (fallback for streaming / empty responses). This
    // ensures a retry never re-executes the handler regardless of
    // how the route calls back to the client. Replay always uses
    // res.json with the persisted body, so res.send/res.end paths
    // on replay will receive a JSON-serialised approximation.
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    const originalEnd = res.end.bind(res);
    let captured: { status: number; body: unknown } | null = null;

    res.json = function patchedJson(body: unknown) {
      // res.statusCode is set by res.status() before .json() is called.
      // For .json() called without a prior .status(), it defaults to 200.
      captured = { status: res.statusCode, body };
      return originalJson(body);
    };

    res.send = function patchedSend(body?: unknown) {
      if (!captured) {
        let parsedBody: unknown = null;
        if (typeof body === "string") {
          try {
            parsedBody = JSON.parse(body);
          } catch {
            parsedBody = body;
          }
        } else if (Buffer.isBuffer(body)) {
          try {
            parsedBody = JSON.parse(body.toString("utf8"));
          } catch {
            parsedBody = null;
          }
        } else {
          parsedBody = body ?? null;
        }
        captured = { status: res.statusCode, body: parsedBody };
      }
      return originalSend(body);
    };

    res.end = function patchedEnd(
      chunk?: unknown,
      encodingOrCb?: BufferEncoding | (() => void),
      cb?: () => void,
    ) {
      if (!captured) {
        captured = { status: res.statusCode, body: null };
      }
      if (typeof encodingOrCb === "function") {
        return originalEnd(chunk, encodingOrCb);
      }
      return originalEnd(chunk, encodingOrCb as BufferEncoding, cb);
    };

    res.on("finish", () => {
      if (!captured) return;
      // Only persist successful responses. See file header rationale.
      if (captured.status < 200 || captured.status >= 300) return;

      const expiresAt = new Date(Date.now() + TTL_MS);
      const persistDb = drizzle(getDbPool());
      // Wrap in async IIFE so .catch lives on a true Promise; the
      // drizzle query builder is a thenable, not a Promise, and only
      // exposes `.then(...)`.
      void (async () => {
        try {
          await persistDb
            .insert(idempotencyKeys)
            .values({
              userId,
              endpoint,
              key: trimmed,
              requestHash,
              responseStatus: captured!.status,
              responseBody: captured!.body as never,
              expiresAt,
            })
            .onConflictDoUpdate({
              target: [
                idempotencyKeys.userId,
                idempotencyKeys.endpoint,
                idempotencyKeys.key,
              ],
              set: {
                requestHash,
                responseStatus: captured!.status,
                responseBody: captured!.body as never,
                createdAt: sql`now()`,
                expiresAt,
              },
            });
        } catch (err: unknown) {
          // Persistence failure is non-fatal: the caller already saw
          // a success and the side-effect is committed. We just
          // won't be able to replay this exact response on a retry.
          logger.warn(
            {
              err:
                err instanceof Error
                  ? { name: err.name, message: err.message }
                  : err,
              endpoint,
            },
            "withIdempotency: failed to persist response (replay unavailable for this key)",
          );
        }
      })();
    });

    next();
  };
}

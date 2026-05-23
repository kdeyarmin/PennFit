// pg-boss job: dispatch queued webhook deliveries.
//
// Runs every 60 seconds. Pulls a small batch of due deliveries
// (status='queued' AND next_attempt_at <= now()), POSTs each one
// to the subscriber's URL with an HMAC-SHA256 signature header,
// and on failure schedules an exponential backoff retry (2^n
// minutes; capped at the subscription's max_retries).
//
// On final exhaustion the row lands in status='exhausted'; the
// admin UI surfaces it for manual review (rebuild the subscription
// or hand-replay via a separate retry-now route).
//
// PHI posture: the dispatcher never logs payload bodies. Failure
// logs contain subscription_id + last_http_status only.

import { createHmac } from "node:crypto";

import type PgBoss from "pg-boss";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  SsrfError,
  assertSafeOutboundHost,
  assertSafeOutboundUrlSync,
} from "../../lib/safe-outbound";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

const JOB = "webhook.dispatch";
const CRON = "* * * * *"; // every minute
const BATCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 15_000;

export interface DispatchStats {
  scanned: number;
  delivered: number;
  retried: number;
  exhausted: number;
}

export async function runWebhookDispatcher(
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<DispatchStats> {
  const supabase = getSupabaseServiceRoleClient();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const stats: DispatchStats = {
    scanned: 0,
    delivered: 0,
    retried: 0,
    exhausted: 0,
  };
  const nowIso = new Date().toISOString();
  const { data: deliveries } = await supabase
    .schema("resupply")
    .from("webhook_deliveries")
    .select(
      "id, subscription_id, event_type, event_payload, attempt_count",
    )
    .eq("status", "queued")
    .lte("next_attempt_at", nowIso)
    .order("next_attempt_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (!deliveries || deliveries.length === 0) return stats;
  stats.scanned = deliveries.length;

  // Group by subscription_id so we resolve each subscription row
  // once per tick.
  const subIds = [...new Set(deliveries.map((d) => d.subscription_id))];
  const { data: subs } = await supabase
    .schema("resupply")
    .from("webhook_subscriptions")
    .select("id, target_url, signing_secret, max_retries, is_active")
    .in("id", subIds);
  const subById = new Map(
    (subs ?? []).map((s) => [s.id, s] as const),
  );

  for (const delivery of deliveries) {
    const sub = subById.get(delivery.subscription_id);
    if (!sub || !sub.is_active) {
      // Subscription paused/deleted between enqueue and dispatch.
      await supabase
        .schema("resupply")
        .from("webhook_deliveries")
        .update({
          status: "exhausted",
          last_error: "subscription inactive at dispatch time",
        })
        .eq("id", delivery.id);
      stats.exhausted += 1;
      continue;
    }
    // SSRF defence: re-validate URL shape AND resolve DNS at
    // dispatch time. The route already rejects obvious IP-literal
    // bad cases; this catch is for DNS rebinding (host resolves to
    // a private IP between validate and fetch) and for legacy
    // subscriptions persisted before the route guard existed.
    let parsedUrl: URL;
    try {
      parsedUrl = assertSafeOutboundUrlSync(sub.target_url);
    } catch (err) {
      const reason = err instanceof SsrfError ? err.reason : "unsafe_url";
      await supabase
        .schema("resupply")
        .from("webhook_deliveries")
        .update({
          status: "exhausted",
          last_error: `target_url rejected: ${reason}`,
        })
        .eq("id", delivery.id);
      stats.exhausted += 1;
      continue;
    }
    try {
      await assertSafeOutboundHost(parsedUrl.hostname);
    } catch (err) {
      const reason = err instanceof SsrfError ? err.reason : "dns_failed";
      await supabase
        .schema("resupply")
        .from("webhook_deliveries")
        .update({
          status: "exhausted",
          last_error: `target_url rejected: ${reason}`,
        })
        .eq("id", delivery.id);
      stats.exhausted += 1;
      continue;
    }
    const body = JSON.stringify(delivery.event_payload);
    const signature = signBody(sub.signing_secret, body);
    const attempt = await attemptOnce(
      fetchImpl,
      sub.target_url,
      delivery,
      body,
      signature,
    );
    if (attempt.ok) {
      await supabase
        .schema("resupply")
        .from("webhook_deliveries")
        .update({
          status: "delivered",
          attempt_count: delivery.attempt_count + 1,
          last_http_status: attempt.httpStatus,
          last_error: null,
          delivered_at: new Date().toISOString(),
        })
        .eq("id", delivery.id);
      await supabase
        .schema("resupply")
        .from("webhook_subscriptions")
        .update({
          last_delivery_at: new Date().toISOString(),
          last_delivery_status: "delivered",
        })
        .eq("id", sub.id);
      stats.delivered += 1;
      continue;
    }
    const httpStatus = attempt.httpStatus;
    const errorMessage = attempt.errorMessage;
    await applyRetryOrExhaust(
      supabase,
      delivery,
      sub.max_retries,
      httpStatus,
      errorMessage,
      stats,
    );
  }
  return stats;
}

function signBody(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

interface AttemptResult {
  ok: boolean;
  httpStatus: number | null;
  errorMessage: string;
}

async function attemptOnce(
  fetchImpl: typeof fetch,
  url: string,
  delivery: { id: string; event_type: string },
  body: string,
  signature: string,
): Promise<AttemptResult> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PennFit-Event-Type": delivery.event_type,
        "X-PennFit-Delivery-Id": delivery.id,
        "X-PennFit-Signature": signature,
        "User-Agent": "PennFit-Webhooks/1.0",
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, httpStatus: res.status, errorMessage: "" };
    }
    return {
      ok: false,
      httpStatus: res.status,
      errorMessage: `subscriber http ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      httpStatus: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

async function applyRetryOrExhaust(
  supabase: SupabaseClient,
  delivery: { id: string; attempt_count: number },
  maxRetries: number,
  httpStatus: number | null,
  errorMessage: string | null,
  stats: DispatchStats,
): Promise<void> {
  const nextAttempt = delivery.attempt_count + 1;
  if (nextAttempt >= maxRetries) {
    await supabase
      .schema("resupply")
      .from("webhook_deliveries")
      .update({
        status: "exhausted",
        attempt_count: nextAttempt,
        last_http_status: httpStatus,
        last_error: (errorMessage ?? "unknown").slice(0, 2000),
      })
      .eq("id", delivery.id);
    stats.exhausted += 1;
    return;
  }
  // Exponential backoff: 2^attempt minutes, capped at 4 hours.
  const backoffMin = Math.min(240, Math.pow(2, nextAttempt));
  const nextAt = new Date(Date.now() + backoffMin * 60 * 1000).toISOString();
  await supabase
    .schema("resupply")
    .from("webhook_deliveries")
    .update({
      attempt_count: nextAttempt,
      last_http_status: httpStatus,
      last_error: (errorMessage ?? "unknown").slice(0, 2000),
      next_attempt_at: nextAt,
    })
    .eq("id", delivery.id);
  stats.retried += 1;
}

export async function registerWebhookDispatcherJob(
  boss: PgBoss,
): Promise<void> {
  await boss.createQueue(JOB);
  await boss.work(JOB, async () => {
    try {
      const stats = await runWebhookDispatcher();
      if (stats.scanned > 0) {
        logger.info(
          { event: "webhook.dispatch.completed", ...stats },
          "webhook.dispatch: tick",
        );
      }
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "webhook.dispatch: failed",
      );
      throw err;
    }
  });
  await boss.schedule(JOB, CRON);
  logger.info({ cron: CRON }, "webhook.dispatch scheduled");
}

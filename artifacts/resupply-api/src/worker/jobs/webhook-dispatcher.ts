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
  createQueueWithDlq,
  WEBHOOK_DISPATCH_QUEUE_OPTS,
} from "../lib/queue-options";
import {
  SsrfError,
  assertSafeOutboundHost,
  assertSafeOutboundUrlSync,
  fetchWithPinnedIp,
} from "../../lib/safe-outbound";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

const JOB = "webhook.dispatch";
const CRON = "* * * * *"; // every minute
const BATCH_SIZE = 50;
// Per-subscriber HTTP timeout. Lowered from 15s so a slow / dead
// subscriber doesn't stall the whole batch; 5s is well above the
// p99 we see for healthy webhook endpoints.
const REQUEST_TIMEOUT_MS = 5_000;
// Lease horizon for an in-flight delivery. We bump
// `next_attempt_at` this far into the future when we claim a row,
// so an overlapping cron tick filters it out. Long enough to cover
// the per-request timeout + DNS resolve + a generous buffer, short
// enough that a worker crash mid-flight leaves the row recoverable
// on the next cron tick rather than the next exponential-backoff
// window.
const CLAIM_LEASE_MS = 5 * 60_000;
// Cap on parallel POSTs per tick so one tick can't fan out 50 × 5s
// = 250s of wall time. With concurrency=8 the worst-case tick is
// ~7 × 5s = 35s for a 50-row batch, well inside the 60s cron
// cadence even when every subscriber is slow.
const MAX_PARALLEL = 8;

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

  // Step 1: find candidates. This SELECT is racy on its own — two
  // overlapping cron ticks would both see the same rows. The atomic
  // claim below filters down to the rows THIS tick actually owns.
  const { data: candidates } = await supabase
    .schema("resupply")
    .from("webhook_deliveries")
    .select("id")
    .eq("status", "queued")
    .lte("next_attempt_at", nowIso)
    .order("next_attempt_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (!candidates || candidates.length === 0) return stats;

  // Step 2: atomic claim. Bump next_attempt_at on these rows IF
  // they're still queued AND still due. PostgREST runs this as a
  // single UPDATE; RETURNING (.select) gives us only the rows we
  // successfully leased.
  //
  // Exclusivity against an OVERLAPPING tick (one that already ran
  // its candidate SELECT before we committed) hinges on the
  // `next_attempt_at <= nowIso` guard, NOT on the status guard:
  // we deliberately keep status='queued' (so a worker crash leaves
  // the row recoverable on the next tick), which means status alone
  // is unchanged by the claim and a concurrent UPDATE re-checking
  // `status='queued'` would still match → double delivery. By also
  // guarding on `next_attempt_at <= nowIso`, our bump to `leaseUntil`
  // (CLAIM_LEASE_MS into the future) makes the row fail the other
  // tick's re-evaluated WHERE (Postgres re-applies an UPDATE's
  // qualifier against the latest committed row version once the row
  // lock is released), so exactly one tick wins each row. The same
  // future bump also hides the row from the next tick's candidate
  // SELECT; on worker crash the lease expires and the row is picked
  // up again.
  const leaseUntil = new Date(Date.now() + CLAIM_LEASE_MS).toISOString();
  const candidateIds = candidates.map((c) => c.id);
  const { data: deliveries, error: claimErr } = await supabase
    .schema("resupply")
    .from("webhook_deliveries")
    .update({ next_attempt_at: leaseUntil, updated_at: nowIso })
    .in("id", candidateIds)
    .eq("status", "queued")
    .lte("next_attempt_at", nowIso)
    .select("id, subscription_id, event_type, event_payload, attempt_count");
  if (claimErr) throw claimErr;
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
  const subById = new Map((subs ?? []).map((s) => [s.id, s] as const));

  // Step 3: process the claimed batch with bounded parallelism so a
  // slow / dead subscriber doesn't serialise the whole batch. With
  // MAX_PARALLEL=8 and REQUEST_TIMEOUT_MS=5_000, a 50-row tick
  // worst-case is ~32s — under the 60s cron cadence.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < deliveries!.length) {
      const idx = cursor++;
      await processOne(deliveries![idx]);
    }
  }
  type Delivery = NonNullable<typeof deliveries>[number];
  async function processOne(delivery: Delivery): Promise<void> {
    const sub = subById.get(delivery.subscription_id);
    if (!sub || !sub.is_active) {
      await supabase
        .schema("resupply")
        .from("webhook_deliveries")
        .update({
          status: "exhausted",
          last_error: "subscription inactive at dispatch time",
        })
        .eq("id", delivery.id);
      stats.exhausted += 1;
      return;
    }
    // SSRF defence: re-validate URL shape AND resolve DNS at
    // dispatch time. The route already rejects obvious IP-literal
    // bad cases; this catch is for DNS rebinding and for legacy
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
      return;
    }
    let pinnedIp: string;
    try {
      pinnedIp = await assertSafeOutboundHost(parsedUrl.hostname);
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
      return;
    }
    const body = JSON.stringify(delivery.event_payload);
    const signature = signBody(sub.signing_secret, body);
    const attempt = await attemptOnce(
      fetchImpl,
      sub.target_url,
      parsedUrl.hostname,
      pinnedIp,
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
      return;
    }
    await applyRetryOrExhaust(
      supabase,
      delivery,
      sub.max_retries,
      attempt.httpStatus,
      attempt.errorMessage,
      stats,
    );
  }
  await Promise.all(
    Array.from({ length: Math.min(MAX_PARALLEL, deliveries.length) }, () =>
      worker(),
    ),
  );
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
  originalHostname: string,
  pinnedIp: string,
  delivery: { id: string; event_type: string },
  body: string,
  signature: string,
): Promise<AttemptResult> {
  try {
    const res = await fetchWithPinnedIp(
      fetchImpl,
      url,
      pinnedIp,
      originalHostname,
      {
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
      },
    );
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
  // Outbound webhook delivery — generous retries (subscriber 5xx
  // during their own deploys is common) + tighter expiry guard
  // against wedged HTTP sockets, with DLQ for exhausted retries.
  await createQueueWithDlq(boss, JOB, WEBHOOK_DISPATCH_QUEUE_OPTS);
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

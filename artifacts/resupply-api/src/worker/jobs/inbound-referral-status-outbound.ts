// pg-boss job: drain inbound_referral_status_outbox + POST to the
// originating source's callback URL.
//
// Cadence
// -------
// Every minute. Status events are infrequent (one per accept,
// shipment, PA decision per referral) so a tight poll is fine.
//
// What the job does
// -----------------
// 1. SELECT inbound_referral_status_outbox
//      WHERE status='queued' AND next_attempt_at <= now()
//      LIMIT BATCH_SIZE.
// 2. For each row, resolve (url, secret) by target_kind:
//      - parachute: env-based (PARACHUTE_API_BASE_URL +
//        PARACHUTE_SIGNING_SECRET). URL is base + /callbacks/status.
//      - ehr_fhir : look up ehr_fhir_tenants by referral.source slug.
//        Uses tenant.callback_url + tenant.outbound_signing_secret.
//    On unresolved (env or row missing), the outbox row is marked
//    exhausted with a clear reason — the rotate-secret path uses a
//    cleaner re-enqueue rather than retrying.
// 3. Sign the payload_json body with HMAC-SHA256 (Stripe-style
//    `t=<ts>,v1=<hex>` for parachute; same shape for ehr_fhir so
//    one signature library handles both).
// 4. POST with a 15s timeout. 2xx → status='delivered'; 4xx →
//    'failed' + next_attempt_at + exp-backoff; 5xx + transport
//    errors → same. After max_retries, status='exhausted'.
//
// PHI posture: payload bodies are NOT logged on success. On failure
// we log row id + last_http_status + error message but never the
// payload bytes. (The audit row + the outbox row itself preserve
// the payload — it's available for retrieval but not reflected to
// logs.)

import type PgBoss from "pg-boss";

import {
  SsrfError,
  assertSafeOutboundHost,
  assertSafeOutboundUrlSync,
  fetchWithPinnedIp,
} from "../../lib/safe-outbound";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import { signParachutePayload } from "@workspace/resupply-integrations-parachute";

import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";

/** Thrown when the partner-supplied callback URL is permanently unsafe. */
class OutboundUrlUnsafeError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "OutboundUrlUnsafeError";
  }
}

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;
type OutboxRow =
  Database["resupply"]["Tables"]["inbound_referral_status_outbox"]["Row"];

const JOB = "inbound-referral.status-outbound";
const CRON = "* * * * *"; // every minute
const BATCH_SIZE = 50;
// Per-request timeout. Was 15s; lowered to 5s so a single slow
// subscriber can't stall the whole batch. 5s is well above the p99
// of healthy partner callback endpoints (Parachute / Athena both
// p99 under 1s in production telemetry).
const REQUEST_TIMEOUT_MS = 5_000;
// Cap on parallel POSTs per tick. With concurrency=8 and 5s
// timeout, the worst-case wall time for a 50-row tick is ~32s —
// well inside the 60s cron cadence AND well inside the lease
// below, so a tick can never have its rows re-claimed mid-flight.
const MAX_PARALLEL = 8;
// Lease horizon for an in-flight row. We bump `next_attempt_at`
// this far into the future when we claim a row, so an overlapping
// cron tick filters it out. Comfortably above the worst-case
// per-tick wall time (BATCH_SIZE/MAX_PARALLEL × REQUEST_TIMEOUT_MS
// = ~32s) so a crashed worker leaves the row recoverable in
// minutes rather than the next exponential-backoff window.
const CLAIM_LEASE_MS = 5 * 60_000;

export interface CallbackStats {
  scanned: number;
  delivered: number;
  retried: number;
  exhausted: number;
}

export async function runReferralStatusOutbound(
  opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<CallbackStats> {
  const supabase = getSupabaseServiceRoleClient();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;
  const stats: CallbackStats = {
    scanned: 0,
    delivered: 0,
    retried: 0,
    exhausted: 0,
  };

  const nowIso = new Date().toISOString();

  // Step 1: find candidates. Racy on its own — two overlapping
  // cron ticks would both see the same rows. The atomic claim
  // below filters down to this tick's winners.
  const { data: candidates, error: candidateErr } = await supabase
    .schema("resupply")
    .from("inbound_referral_status_outbox")
    .select("id")
    .eq("status", "queued")
    .lte("next_attempt_at", nowIso)
    .order("next_attempt_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (candidateErr) {
    logger.error(
      { err: candidateErr.message },
      "inbound_referral.status_outbound.select_failed",
    );
    throw candidateErr;
  }
  if (!candidates || candidates.length === 0) return stats;

  // Step 2: atomic lease. Bump next_attempt_at on these rows into the
  // future; RETURNING (.select) gives us the rows we actually leased.
  //
  // Exclusivity against an OVERLAPPING tick (one that ran its candidate
  // SELECT before we committed) hinges on the `next_attempt_at <= nowIso`
  // guard, NOT on the status guard: we deliberately keep status='queued'
  // (so a worker crash leaves the row recoverable), so status is unchanged
  // by the claim and a concurrent UPDATE re-checking only status='queued'
  // would still match → double delivery (a double partner callback). By
  // also guarding on `next_attempt_at <= nowIso`, our bump to `leaseUntil`
  // makes the row fail the other tick's re-evaluated WHERE, so exactly one
  // tick wins each row. Mirrors webhook-dispatcher.ts.
  const leaseUntil = new Date(Date.now() + CLAIM_LEASE_MS).toISOString();
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("inbound_referral_status_outbox")
    .update({ next_attempt_at: leaseUntil, updated_at: nowIso })
    .in(
      "id",
      candidates.map((c) => c.id),
    )
    .eq("status", "queued")
    .lte("next_attempt_at", nowIso)
    .select(
      "id, referral_id, target_kind, event_type, payload_json, attempt_count, max_retries, status",
    );
  if (error) {
    logger.error(
      { err: error.message },
      "inbound_referral.status_outbound.claim_failed",
    );
    throw error;
  }
  if (!rows || rows.length === 0) return stats;
  stats.scanned = rows.length;

  // Resolve referral.source for each row in one go to avoid N+1.
  const referralIds = [...new Set(rows.map((r) => r.referral_id))];
  const { data: referrals } = await supabase
    .schema("resupply")
    .from("inbound_referral_orders")
    .select("id, source")
    .in("id", referralIds);
  const sourceByReferral = new Map<string, string>(
    (referrals ?? []).map((r) => [r.id, r.source] as const),
  );

  // Bounded parallelism so a slow / dead partner doesn't serialise
  // the batch (50 × 5s = 250s sequentially, vs ~32s at concurrency=8).
  // Stays comfortably inside both the 60s cron cadence and the
  // CLAIM_LEASE_MS window so rows can't be re-claimed mid-flight.
  const claimedRows = rows;
  let cursor = 0;
  type Row = (typeof claimedRows)[number];
  async function processOne(row: Row): Promise<void> {
    const source = sourceByReferral.get(row.referral_id);
    if (!source) {
      await markExhausted(supabase, row.id, "referral_missing", null, stats);
      return;
    }
    const target = await resolveTarget({
      supabase,
      env,
      source,
      targetKind: row.target_kind,
    });
    if (!target) {
      await markExhausted(
        supabase,
        row.id,
        "target_not_configured",
        null,
        stats,
      );
      return;
    }

    const rawBody = JSON.stringify(row.payload_json);
    const signature = signParachutePayload(rawBody, target.signingSecret);

    try {
      const resp = await postWithTimeout(
        fetchImpl,
        target.url,
        rawBody,
        signature,
      );
      if (resp.ok) {
        await markDelivered(supabase, row.id, resp.status);
        stats.delivered += 1;
      } else if (resp.status >= 500 || resp.status === 429) {
        await scheduleRetry(
          supabase,
          row,
          resp.status,
          `http_${resp.status}`,
          stats,
        );
      } else {
        // 4xx — partner rejected. Retry once just in case it's a
        // transient config issue, then exhaust.
        if (row.attempt_count + 1 >= row.max_retries) {
          await markExhausted(
            supabase,
            row.id,
            `http_${resp.status}`,
            resp.status,
            stats,
          );
        } else {
          await scheduleRetry(
            supabase,
            row,
            resp.status,
            `http_${resp.status}`,
            stats,
          );
        }
      }
    } catch (err) {
      if (err instanceof OutboundUrlUnsafeError) {
        // Permanently-unsafe target URL (private IP, http-only, DNS
        // rebinding). Exhaust immediately — retrying will never make
        // the URL safe, and a partner who controls target_url could
        // otherwise silently consume our retry budget by submitting
        // bad URLs.
        await markExhausted(supabase, row.id, err.reason, null, stats);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      await scheduleRetry(supabase, row, null, message.slice(0, 500), stats);
    }
  }
  async function worker(): Promise<void> {
    while (cursor < claimedRows.length) {
      const idx = cursor++;
      await processOne(claimedRows[idx]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(MAX_PARALLEL, claimedRows.length) }, () =>
      worker(),
    ),
  );
  return stats;
}

interface ResolvedTarget {
  url: string;
  signingSecret: string;
}

async function resolveTarget(input: {
  supabase: SupabaseClient;
  env: NodeJS.ProcessEnv;
  source: string;
  targetKind: string;
}): Promise<ResolvedTarget | null> {
  if (input.targetKind === "parachute") {
    const base = input.env.PARACHUTE_API_BASE_URL?.replace(/\/+$/u, "") ?? "";
    const secret = input.env.PARACHUTE_SIGNING_SECRET ?? "";
    if (!base || !secret) return null;
    return {
      url: `${base}/callbacks/status`,
      signingSecret: secret,
    };
  }
  if (input.targetKind === "ehr_fhir") {
    const slug = input.source.replace(/^ehr_fhir_/, "");
    const { data: tenant } = await input.supabase
      .schema("resupply")
      .from("ehr_fhir_tenants")
      .select("callback_url, outbound_signing_secret, is_active")
      .eq("slug", slug)
      .limit(1)
      .maybeSingle();
    if (!tenant || !tenant.is_active) return null;
    if (!tenant.callback_url || !tenant.outbound_signing_secret) return null;
    return {
      url: tenant.callback_url,
      signingSecret: tenant.outbound_signing_secret,
    };
  }
  return null;
}

async function postWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  body: string,
  signature: string,
): Promise<Response> {
  // SSRF defence: validate URL shape AND resolve DNS so a
  // partner-supplied (DB-stored) callback URL can't be turned
  // into an internal-network probe. assertSafeOutboundUrlSync
  // also enforces https-only.
  //
  // Why we throw instead of synthesizing a 400 response: the caller
  // (`processOne`) treats `status: 400` as a partner-rejected 4xx
  // and schedules retries up to `max_retries` before exhausting. A
  // permanently-unsafe URL (private IP, http-only, DNS rebinding)
  // can never become safe, so retrying just burns the retry budget
  // — and worse, a partner who controls the `target_url` column
  // could use it to silently consume our retry capacity. Throwing a
  // dedicated `OutboundUrlUnsafeError` lets the caller mark the row
  // exhausted immediately with a precise reason code.
  let parsedUrl: URL;
  try {
    parsedUrl = assertSafeOutboundUrlSync(url);
  } catch (err) {
    const reason = err instanceof SsrfError ? err.reason : "unsafe_url";
    throw new OutboundUrlUnsafeError(reason);
  }
  let pinnedIp: string;
  try {
    pinnedIp = await assertSafeOutboundHost(parsedUrl.hostname);
  } catch (err) {
    const reason = err instanceof SsrfError ? err.reason : "dns_failed";
    throw new OutboundUrlUnsafeError(reason);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchWithPinnedIp(
      fetchImpl,
      url,
      pinnedIp,
      parsedUrl.hostname,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PennFit-Signature": signature,
        },
        body,
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function markDelivered(
  supabase: SupabaseClient,
  rowId: string,
  httpStatus: number,
): Promise<void> {
  await supabase
    .schema("resupply")
    .from("inbound_referral_status_outbox")
    .update({
      status: "delivered",
      delivered_at: new Date().toISOString(),
      last_http_status: httpStatus,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", rowId);
}

async function scheduleRetry(
  supabase: SupabaseClient,
  row: Pick<OutboxRow, "id" | "attempt_count" | "max_retries">,
  httpStatus: number | null,
  errorMessage: string,
  stats: CallbackStats,
): Promise<void> {
  const nextAttempt = row.attempt_count + 1;
  if (nextAttempt >= row.max_retries) {
    await markExhausted(supabase, row.id, errorMessage, httpStatus, stats);
    return;
  }
  // Exponential backoff: 2^attempt minutes, capped at 4 hours.
  const backoffMin = Math.min(240, Math.pow(2, nextAttempt));
  const nextAt = new Date(Date.now() + backoffMin * 60 * 1000).toISOString();
  const { error } = await supabase
    .schema("resupply")
    .from("inbound_referral_status_outbox")
    .update({
      attempt_count: nextAttempt,
      last_http_status: httpStatus,
      last_error: errorMessage.slice(0, 2000),
      next_attempt_at: nextAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  if (error) {
    logger.warn(
      { row_id: row.id, err: error.message },
      "inbound_referral.status_outbound.schedule_retry_failed",
    );
  }
  stats.retried += 1;
}

async function markExhausted(
  supabase: SupabaseClient,
  rowId: string,
  reason: string,
  httpStatus: number | null,
  stats: CallbackStats,
): Promise<void> {
  await supabase
    .schema("resupply")
    .from("inbound_referral_status_outbox")
    .update({
      status: "exhausted",
      last_http_status: httpStatus,
      last_error: reason.slice(0, 2000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", rowId);
  stats.exhausted += 1;
}

export async function registerReferralStatusOutboundJob(
  boss: PgBoss,
): Promise<void> {
  if (process.env.RESUPPLY_INBOUND_REFERRALS_ENABLED !== "1") {
    // Inbound referral / EHR integration is not provisioned here — the
    // inbound_referral_* / ehr_fhir_tenants tables only exist once that
    // integration is set up (see docs/db-schema-drift-2026-05-29.md).
    // Unschedule any cron a prior deploy left behind so it stops firing
    // into missing tables, then skip worker registration. Set
    // RESUPPLY_INBOUND_REFERRALS_ENABLED=1 once the schema + a partner
    // tenant exist.
    if (typeof boss.unschedule === "function") {
      await boss.unschedule(JOB).catch(() => undefined);
    }
    logger.info(
      { event: "inbound_referral_jobs_disabled", job: JOB },
      `${JOB}: not registered (RESUPPLY_INBOUND_REFERRALS_ENABLED!=1); cleared any stale cron`,
    );
    return;
  }
  await createQueueWithDlq(boss, JOB, VENDOR_SEND_QUEUE_OPTS);
  await boss.work(JOB, async () => {
    try {
      // Runtime kill switch (admin Control Center). The env var gates
      // registration; this flag pauses the callbacks without changing env.
      if (!(await isFeatureEnabled("inbound_referrals.dispatcher"))) {
        return;
      }
      const stats = await runReferralStatusOutbound();
      if (stats.scanned > 0) {
        logger.info(
          {
            event: "inbound_referral.status_outbound.tick",
            ...stats,
          },
          "inbound_referral.status_outbound: tick",
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
        "inbound_referral.status_outbound: failed",
      );
      throw err;
    }
  });
  await boss.schedule(JOB, CRON);
  logger.info({ cron: CRON }, "inbound_referral.status_outbound scheduled");
}

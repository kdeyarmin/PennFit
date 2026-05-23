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
} from "../../lib/safe-outbound";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import { signParachutePayload } from "@workspace/resupply-integrations-parachute";

import { logger } from "../../lib/logger";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;
type OutboxRow =
  Database["resupply"]["Tables"]["inbound_referral_status_outbox"]["Row"];

const JOB = "inbound-referral.status-outbound";
const CRON = "* * * * *"; // every minute
const BATCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 15_000;

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
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("inbound_referral_status_outbox")
    .select(
      "id, referral_id, target_kind, event_type, payload_json, attempt_count, max_retries, status",
    )
    .eq("status", "queued")
    .lte("next_attempt_at", nowIso)
    .order("next_attempt_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (error) {
    logger.error(
      { err: error.message },
      "inbound_referral.status_outbound.select_failed",
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

  for (const row of rows) {
    const source = sourceByReferral.get(row.referral_id);
    if (!source) {
      await markExhausted(supabase, row.id, "referral_missing", null, stats);
      continue;
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
      continue;
    }

    const rawBody = JSON.stringify(row.payload_json);
    const signature = signParachutePayload(rawBody, target.signingSecret);

    try {
      const resp = await postWithTimeout(fetchImpl, target.url, rawBody, signature);
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
      const message = err instanceof Error ? err.message : String(err);
      await scheduleRetry(supabase, row, null, message.slice(0, 500), stats);
    }
  }
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
  let parsedUrl: URL;
  try {
    parsedUrl = assertSafeOutboundUrlSync(url);
  } catch (err) {
    const reason = err instanceof SsrfError ? err.reason : "unsafe_url";
    return new Response(reason, { status: 400 });
  }
  try {
    await assertSafeOutboundHost(parsedUrl.hostname);
  } catch (err) {
    const reason = err instanceof SsrfError ? err.reason : "dns_failed";
    return new Response(reason, { status: 400 });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PennFit-Signature": signature,
      },
      body,
      signal: controller.signal,
    });
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
  await boss.createQueue(JOB);
  await boss.work(JOB, async () => {
    try {
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

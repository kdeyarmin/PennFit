// Cart-abandonment dispatcher — shared between the admin "send-due"
// route and the hourly pg-boss cron (A1).
//
// The same scan + suppression + per-row send loop is wanted from two
// callers: the admin button, where staff can trigger a sweep on demand,
// and the worker, which runs the sweep automatically every hour so
// abandoned carts don't sit idle until someone clicks. Extracting the
// logic here keeps a single source of truth for the suppression rules
// and the stats payload shape.
//
// Suppression policy (mirrors the file-header rules in
// artifacts/resupply-api/src/routes/admin/abandoned-carts.ts):
//   * items != []                — there's something to nudge about
//   * reminded_at IS NULL        — only one nudge per cart-event
//   * recovered_at IS NULL       — they already paid; never nudge
//   * cleared_at IS NULL         — they explicitly emptied; respect it
//   * email IS NOT NULL          — auth lookup must have succeeded
//   * updated_at <= now() - 24h  — give them a real chance to come
//                                   back on their own first
//   * communication_preferences.emailAbandonedCart != false
//   * not currently inside the customer's DND window
//
// Idempotency: a second invocation immediately after the first finds
// `reminded_at IS NOT NULL` for every row we just stamped, so it sends
// nothing. Safe to re-run.
//
// Concurrency posture: two callers stamping in parallel both
// SELECT-then-UPDATE; the second UPDATE matches zero rows because
// the first already cleared the null guard. Correctness preserved,
// parallelism lost — fine for an hourly sweep with a 200-row cap.

import {
  DEFAULT_COMMUNICATION_PREFERENCES,
  getSupabaseServiceRoleClient,
  type CommunicationPreferences,
  type ShopAbandonedCartItem,
} from "@workspace/resupply-db";

import { isInDndWindow } from "../comm-prefs";
import { isFeatureEnabled } from "../feature-flags";
import { sendCartAbandonmentEmail } from "./send-cart-abandonment-email";

/**
 * Stats envelope returned to BOTH the admin route and the worker.
 * The shape is the same so the admin UI doesn't have to special-case
 * cron vs. button-triggered runs, and the worker can log the same
 * counters for ops dashboards.
 */
export interface CartAbandonmentStats {
  /** Rows that survived the SQL filters and were stamped reminded_at. */
  scanned: number;
  /** Rows for which SendGrid accepted the email. */
  sent: number;
  /** Rows where SendGrid was not configured (env missing or invalid). */
  skippedNoConfig: number;
  /** Rows where the send attempt failed for any other reason. */
  skippedFailed: number;
  /** Rows suppressed by communication_preferences or DND. */
  skippedOptOut: number;
  /**
   * True if SendGrid stayed configured throughout the run. Flipped to
   * false the moment any send throws EmailConfigError (or any other
   * error from the client construction); we abort the remainder of
   * the batch and unclaim everything that wasn't tried.
   */
  sendgridConfigured: boolean;
}

/** Minimum age (24h) before a cart becomes eligible for a nudge. */
export const CART_ABANDONMENT_NUDGE_WAIT_MS = 24 * 60 * 60 * 1000;

/**
 * Maximum number of rows pulled per dispatcher invocation. The hourly
 * cron + the admin button share this cap so a manual click can't drain
 * SendGrid quota and a scheduled run can't spike DB load.
 */
export const CART_ABANDONMENT_SCAN_LIMIT = 200;

/**
 * Lightweight logger contract — accepts pino-style (req.log,
 * worker logger) and noops. Just `warn` is needed today; if a future
 * caller needs `info` or `error` from here, add them.
 */
export interface CartAbandonmentLogger {
  warn?: (context: Record<string, unknown>, message: string) => void;
}

function mergePrefs(stored: CommunicationPreferences | null) {
  return stored
    ? { ...DEFAULT_COMMUNICATION_PREFERENCES, ...stored }
    : { ...DEFAULT_COMMUNICATION_PREFERENCES };
}

/**
 * Run one cart-abandonment sweep end-to-end. Identical SQL + send
 * loop as the admin POST handler used to inline.
 *
 * `now` is injectable for tests; production callers omit it and we
 * use real wall-clock time. `log` is best-effort — when omitted we
 * swallow warning paths silently (the worker passes its own logger).
 */
export async function runCartAbandonmentDispatch(
  opts: {
    now?: Date;
    log?: CartAbandonmentLogger;
  } = {},
): Promise<CartAbandonmentStats> {
  // Control Center feature gate — admins can disable the nudge
  // dispatcher from /admin/control-center without a deploy. Returns
  // the same zeroed stats envelope as a no-eligible-rows scan, so
  // the admin "Run now" button surfaces "0 sent" instead of an error.
  if (!(await isFeatureEnabled("cart_abandonment.dispatcher"))) {
    opts.log?.warn?.(
      { event: "cart_abandonment_dispatch_skipped_feature_disabled" },
      "cart-abandonment dispatcher skipped — feature flag disabled",
    );
    return {
      scanned: 0,
      sent: 0,
      skippedNoConfig: 0,
      skippedFailed: 0,
      skippedOptOut: 0,
      sendgridConfigured: true,
    };
  }

  const supabase = getSupabaseServiceRoleClient();
  const now = opts.now ?? new Date();
  const cutoffIso = new Date(
    now.getTime() - CART_ABANDONMENT_NUDGE_WAIT_MS,
  ).toISOString();

  const { data: candidates, error: candidatesErr } = await supabase
    .schema("resupply")
    .from("shop_abandoned_carts")
    .select("id")
    .lte("updated_at", cutoffIso)
    .is("reminded_at", null)
    .is("recovered_at", null)
    .is("cleared_at", null)
    .not("email", "is", null)
    .neq("items", "[]")
    .order("updated_at", { ascending: true })
    .limit(CART_ABANDONMENT_SCAN_LIMIT);
  if (candidatesErr) throw candidatesErr;

  const candidateIds = (candidates ?? []).map((r) => r.id);
  if (candidateIds.length === 0) {
    return {
      scanned: 0,
      sent: 0,
      skippedNoConfig: 0,
      skippedFailed: 0,
      skippedOptOut: 0,
      sendgridConfigured: true,
    };
  }

  // Atomic stamp: .is("reminded_at", null) guard makes this idempotent
  // under parallel invocations. Postgres serialises the UPDATEs, the
  // second one matches zero rows, and that caller does no work.
  const nowIso = now.toISOString();
  const { data: claimedRows, error: claimErr } = await supabase
    .schema("resupply")
    .from("shop_abandoned_carts")
    .update({ reminded_at: nowIso })
    .in("id", candidateIds)
    .is("reminded_at", null)
    .select("id, customer_id, email, items, subtotal_cents, currency");
  if (claimErr) throw claimErr;

  const claimed = (claimedRows ?? []).map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    email: r.email,
    items: (r.items ?? []) as unknown as ShopAbandonedCartItem[],
    subtotalCents: r.subtotal_cents,
    currency: r.currency,
  }));

  const prefsByUser = new Map<string, ReturnType<typeof mergePrefs>>();
  if (claimed.length > 0) {
    const userIds = Array.from(new Set(claimed.map((r) => r.customerId)));
    const { data: customerRows, error: prefsErr } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .select("customer_id, communication_preferences")
      .in("customer_id", userIds);
    if (prefsErr) throw prefsErr;
    for (const cr of customerRows ?? []) {
      prefsByUser.set(
        cr.customer_id,
        mergePrefs(
          (cr.communication_preferences as CommunicationPreferences | null) ??
            null,
        ),
      );
    }
  }

  let sent = 0;
  let skippedNoConfig = 0;
  let skippedFailed = 0;
  let skippedOptOut = 0;
  let configuredFlag = true;

  const unclaim = async (id: string): Promise<void> => {
    const { error: unclaimErr } = await supabase
      .schema("resupply")
      .from("shop_abandoned_carts")
      .update({ reminded_at: null })
      .eq("id", id);
    if (unclaimErr) {
      opts.log?.warn?.(
        { err: unclaimErr, rowId: id },
        "cart-abandonment unclaim failed",
      );
    }
  };

  const unclaimMany = async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return;
    const { error: unclaimErr } = await supabase
      .schema("resupply")
      .from("shop_abandoned_carts")
      .update({ reminded_at: null })
      .in("id", ids);
    if (unclaimErr) {
      opts.log?.warn?.(
        { err: unclaimErr, idCount: ids.length },
        "cart-abandonment unclaim batch failed",
      );
    }
  };

  for (const row of claimed) {
    const prefs = prefsByUser.get(row.customerId) ?? mergePrefs(null);
    if (!prefs.emailAbandonedCart || isInDndWindow(prefs)) {
      await unclaim(row.id);
      skippedOptOut += 1;
      continue;
    }
    if (!row.email) {
      // Belt-and-suspenders: the SQL filter already guarded null
      // emails, but if a row sneaks through we unclaim and skip.
      await unclaim(row.id);
      skippedFailed += 1;
      continue;
    }

    let outcome;
    try {
      outcome = await sendCartAbandonmentEmail({
        toEmail: row.email,
        items: row.items,
        subtotalCents: row.subtotalCents,
        currency: row.currency,
      });
    } catch (err) {
      // Most commonly EmailConfigError when SendGrid env is missing.
      // Treat as "no config" — unclaim so future runs after env is
      // fixed will retry, and abort the loop because none of the
      // remaining sends will succeed either.
      await unclaim(row.id);
      configuredFlag = false;
      skippedNoConfig += 1;
      const remainingIds = claimed
        .slice(claimed.indexOf(row) + 1)
        .map((r) => r.id);
      await unclaimMany(remainingIds);
      skippedNoConfig += remainingIds.length;
      opts.log?.warn?.(
        {
          rowId: row.id,
          err,
        },
        "cart-abandonment send threw — unclaiming batch",
      );
      break;
    }

    if (!outcome.configured) {
      await unclaim(row.id);
      configuredFlag = false;
      skippedNoConfig += 1;
      continue;
    }
    if (!outcome.delivered) {
      await unclaim(row.id);
      skippedFailed += 1;
      opts.log?.warn?.(
        { rowId: row.id, error: outcome.error },
        "cart-abandonment send failed",
      );
      continue;
    }

    sent += 1;
  }

  return {
    scanned: claimed.length,
    sent,
    skippedNoConfig,
    skippedFailed,
    skippedOptOut,
    sendgridConfigured: configuredFlag,
  };
}

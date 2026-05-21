// pg-boss job: scan the Stripe shop catalog every 6 hours and send a
// digest email to admin staff for every SKU whose live stock_count
// has fallen at or below its low-stock threshold.
//
// Why a digest (not one email per SKU):
//   Even on a tight catalog (~30 SKUs) a "one alert per SKU per dip"
//   pattern can flood an inbox during a busy week. Operators want a
//   single rollup they can scan in 10 seconds.
//
// Dedup model — see migration 0142:
//   resupply.low_stock_alert_state holds one row per product_id with
//   last_alerted_at + last_resolved_at. We re-alert in two cases:
//     (1) never alerted before for this dip (no row, OR last_resolved_at
//         is set meaning the SKU recovered and dipped again), OR
//     (2) more than ALERT_COOLDOWN_HOURS have passed since the last
//         alert AND the SKU is still below threshold.
//
// Recipients: RESUPPLY_ADMIN_EMAILS env var (comma-separated). When
// unset, the job logs+exits-0 — a half-configured dev environment
// should not page anyone.
//
// Stripe-not-configured posture: log+exit-0, same as other workers
// that depend on optional integrations. Production preflight catches
// the misconfig before deploy; dev/preview just stays quiet.

import type PgBoss from "pg-boss";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";

import { logger } from "../../lib/logger";
import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import {
  projectProduct,
  type ShopProductView,
} from "../../lib/stripe/products-meta";

const ALERT_JOB = "shop-inventory.low-stock-alerts";
// Every 6 hours at :13 to dodge the top-of-hour cron stampede.
const ALERT_CRON = "13 */6 * * *";
const ALERT_COOLDOWN_HOURS = 24;
// Mirrors the storefront default in shop-api.ts. Used when a SKU has
// no per-SKU threshold set.
const DEFAULT_LOW_STOCK_THRESHOLD = 5;

export interface LowStockAlertStats {
  scanned: number;
  belowThreshold: number;
  newAlerts: number;
  cooldownSkipped: number;
  resolved: number;
  recipients: number;
  emailSent: boolean;
}

interface BelowThresholdSku {
  productId: string;
  name: string;
  stockCount: number;
  threshold: number;
}

function parseRecipientList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s.includes("@"));
}

function effectiveThreshold(product: ShopProductView): number {
  // `null` means "use the storefront default of 5". `0` is an
  // explicit opt-out — the storefront never shows the low badge
  // and we shouldn't alert either. See products-meta.ts for the
  // semantics this mirrors.
  if (product.lowStockThreshold === null) return DEFAULT_LOW_STOCK_THRESHOLD;
  return product.lowStockThreshold;
}

function renderDigest(skus: BelowThresholdSku[]): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `PennPaps inventory alert — ${skus.length} SKU${
    skus.length === 1 ? "" : "s"
  } below threshold`;

  const textLines = [
    `${skus.length} product${skus.length === 1 ? " is" : "s are"} at or below their low-stock threshold:`,
    "",
    ...skus.map(
      (s) =>
        `  • ${s.name} — ${s.stockCount} on hand (threshold ${s.threshold})`,
    ),
    "",
    "Manage inventory: /admin/shop/inventory",
  ];
  const text = textLines.join("\n");

  const rows = skus
    .map(
      (s) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(
            s.name,
          )}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-variant-numeric:tabular-nums;">${
            s.stockCount
          }</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-variant-numeric:tabular-nums;color:#6b7280;">${
            s.threshold
          }</td>
        </tr>`,
    )
    .join("");

  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;background:#f9fafb;margin:0;padding:24px;">
  <table style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;border-collapse:collapse;">
    <tr><td style="padding:20px 24px;background:#0a1f44;color:#ffffff;">
      <h1 style="margin:0;font-size:18px;font-weight:600;">Inventory alert</h1>
      <p style="margin:4px 0 0;font-size:13px;color:#cbd5e1;">${skus.length} product${
        skus.length === 1 ? "" : "s"
      } at or below threshold</p>
    </td></tr>
    <tr><td style="padding:0;">
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="background:#f9fafb;">
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;">Product</th>
          <th style="padding:8px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600;">On hand</th>
          <th style="padding:8px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600;">Threshold</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </td></tr>
    <tr><td style="padding:16px 24px;background:#f9fafb;font-size:12px;color:#6b7280;">
      Adjust stock or thresholds in the admin inventory page.
    </td></tr>
  </table>
</body></html>`;
  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function runLowStockAlerts(): Promise<LowStockAlertStats> {
  const stats: LowStockAlertStats = {
    scanned: 0,
    belowThreshold: 0,
    newAlerts: 0,
    cooldownSkipped: 0,
    resolved: 0,
    recipients: 0,
    emailSent: false,
  };

  const config = readStripeConfigOrNull();
  if (!config) {
    logger.info(
      { event: "shop-inventory.low-stock-alerts.skipped_no_stripe" },
      "low-stock-alerts: Stripe not configured, skipping",
    );
    return stats;
  }
  const stripe = getStripeClient(config);

  const list = await stripe.products.list({
    active: true,
    limit: 100,
    expand: ["data.default_price"],
  });
  const products = list.data
    .map(projectProduct)
    .filter((p): p is ShopProductView => p !== null);
  stats.scanned = products.length;

  // Two buckets:
  //   below — products currently at/below threshold (eligible to alert)
  //   recovered — products with an open alert row that are now ABOVE
  //               their threshold (we stamp last_resolved_at so the
  //               next dip is treated as a fresh alert)
  const below: BelowThresholdSku[] = [];
  const recoveredIds: string[] = [];

  for (const p of products) {
    if (p.stockCount === null) continue; // untracked SKUs never alert
    const threshold = effectiveThreshold(p);
    if (threshold === 0) continue; // explicit opt-out
    if (p.stockCount <= threshold) {
      below.push({
        productId: p.id,
        name: p.name,
        stockCount: p.stockCount,
        threshold,
      });
    } else {
      recoveredIds.push(p.id);
    }
  }
  stats.belowThreshold = below.length;

  const supabase = getSupabaseServiceRoleClient();
  const nowIso = new Date().toISOString();
  const cooldownCutoff = new Date(
    Date.now() - ALERT_COOLDOWN_HOURS * 60 * 60 * 1000,
  ).toISOString();

  // Resolve recovered SKUs: stamp last_resolved_at where a row exists
  // and has an unresolved last_alerted_at. This is the gate that lets
  // the next dip alert again.
  if (recoveredIds.length > 0) {
    const { data: resolved, error: resolveErr } = await supabase
      .schema("resupply")
      .from("low_stock_alert_state")
      .update({ last_resolved_at: nowIso, updated_at: nowIso })
      .in("product_id", recoveredIds)
      .is("last_resolved_at", null)
      .not("last_alerted_at", "is", null)
      .select("product_id");
    if (resolveErr) {
      logger.warn(
        { err: resolveErr.message },
        "low-stock-alerts: failed to mark resolved",
      );
    } else {
      stats.resolved = (resolved ?? []).length;
    }
  }

  if (below.length === 0) {
    logger.info(
      { event: "shop-inventory.low-stock-alerts.no_alerts" },
      "low-stock-alerts: no SKUs below threshold",
    );
    return stats;
  }

  // Decide which below-threshold SKUs are actually alert-eligible
  // (never alerted, or recovered since last alert, or cooldown expired).
  const belowIds = below.map((b) => b.productId);
  const { data: stateRows, error: stateErr } = await supabase
    .schema("resupply")
    .from("low_stock_alert_state")
    .select("product_id, last_alerted_at, last_resolved_at")
    .in("product_id", belowIds);
  if (stateErr) {
    throw new Error(`low-stock-alerts state lookup failed: ${stateErr.message}`);
  }
  const stateById = new Map(
    (stateRows ?? []).map((r) => [
      r.product_id,
      {
        lastAlertedAt: r.last_alerted_at,
        lastResolvedAt: r.last_resolved_at,
      },
    ]),
  );

  const alertable: BelowThresholdSku[] = [];
  for (const sku of below) {
    const state = stateById.get(sku.productId);
    if (!state || !state.lastAlertedAt) {
      // Never alerted before.
      alertable.push(sku);
      continue;
    }
    if (
      state.lastResolvedAt &&
      state.lastResolvedAt > state.lastAlertedAt
    ) {
      // Resolved since last alert; this is a fresh dip.
      alertable.push(sku);
      continue;
    }
    if (state.lastAlertedAt < cooldownCutoff) {
      // Still below, but cooldown expired — nudge again.
      alertable.push(sku);
      continue;
    }
    stats.cooldownSkipped += 1;
  }
  stats.newAlerts = alertable.length;

  if (alertable.length === 0) {
    logger.info(
      {
        event: "shop-inventory.low-stock-alerts.suppressed",
        belowThreshold: below.length,
        cooldownSkipped: stats.cooldownSkipped,
      },
      "low-stock-alerts: all below-threshold SKUs are within cooldown",
    );
    return stats;
  }

  const recipients = parseRecipientList(process.env.RESUPPLY_ADMIN_EMAILS);
  stats.recipients = recipients.length;
  if (recipients.length === 0) {
    logger.warn(
      {
        event: "shop-inventory.low-stock-alerts.no_recipients",
        wouldAlert: alertable.length,
      },
      "low-stock-alerts: RESUPPLY_ADMIN_EMAILS is empty; no email sent",
    );
    // Still upsert state so we don't repeatedly compute the same
    // alertable set without actually delivering anything.
    await upsertAlertState(alertable, nowIso);
    return stats;
  }

  let sendgrid;
  try {
    sendgrid = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      logger.warn(
        {
          event: "shop-inventory.low-stock-alerts.email_unconfigured",
          message: err.message,
        },
        "low-stock-alerts: email not configured; skipping send",
      );
      return stats;
    }
    throw err;
  }

  const { subject, html, text } = renderDigest(alertable);
  let anySent = false;
  for (const to of recipients) {
    try {
      await sendgrid.sendEmail({ to, subject, html, text });
      anySent = true;
    } catch (err) {
      logger.warn(
        {
          to,
          err: err instanceof Error ? err.message : String(err),
        },
        "low-stock-alerts: send failed for one recipient",
      );
    }
  }
  stats.emailSent = anySent;

  // Even on partial send failure, stamp state so the next tick
  // honours the cooldown for the SKUs we tried to alert on. The
  // worst case is a 24h re-attempt for SKUs whose alerts didn't
  // reach anyone — acceptable vs hammering SendGrid every 6h.
  await upsertAlertState(alertable, nowIso);

  return stats;
}

async function upsertAlertState(
  alertable: BelowThresholdSku[],
  nowIso: string,
): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  const rows = alertable.map((sku) => ({
    product_id: sku.productId,
    last_observed_count: sku.stockCount,
    last_threshold: sku.threshold,
    last_alerted_at: nowIso,
    // Clearing last_resolved_at on a fresh alert so future
    // resolve-detection treats this as the open alert window.
    last_resolved_at: null,
    updated_at: nowIso,
  }));
  const { error } = await supabase
    .schema("resupply")
    .from("low_stock_alert_state")
    .upsert(rows, { onConflict: "product_id" });
  if (error) {
    logger.warn(
      { err: error.message },
      "low-stock-alerts: state upsert failed",
    );
  }
}

export async function registerLowStockAlertsJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(ALERT_JOB);
  await boss.work(ALERT_JOB, async () => {
    try {
      const stats = await runLowStockAlerts();
      logger.info(
        { event: "shop-inventory.low-stock-alerts.completed", ...stats },
        "low-stock-alerts: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "low-stock-alerts: failed",
      );
      throw err;
    }
  });
  await boss.schedule(ALERT_JOB, ALERT_CRON);
  logger.info({ cron: ALERT_CRON }, "low-stock-alerts scheduled");
}

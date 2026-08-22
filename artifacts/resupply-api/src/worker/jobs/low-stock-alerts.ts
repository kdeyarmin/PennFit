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

import {
  getOrgScopedClient,
  resolveSeedOrgId,
  type OrgScopedClient,
} from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";

import { resolveSuperAdminRecipients } from "../../lib/admin-assistant/adminAssistantTools";
import { logger } from "../../lib/logger";
import { notifyOpsDigest } from "../../lib/slack/notify";
import { stripeAccountRequestOptions } from "../../lib/stripe/connect";
import { forEachActiveOrg } from "../lib/for-each-active-org.js";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";
import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import {
  projectProduct,
  type ShopProductView,
} from "../../lib/stripe/products-meta";
import { PLATFORM_NAME } from "../../lib/company-info.js";
import {
  BREATHE_COLORS,
  renderBrandedEmail,
  textParagraph,
} from "@workspace/resupply-email";

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

function effectiveThreshold(product: ShopProductView): number {
  // `null` means "use the storefront default of 5". `0` is an
  // explicit opt-out — the storefront never shows the low badge
  // and we shouldn't alert either. See products-meta.ts for the
  // semantics this mirrors.
  if (product.lowStockThreshold === null) return DEFAULT_LOW_STOCK_THRESHOLD;
  return product.lowStockThreshold;
}

function renderDigest(
  skus: BelowThresholdSku[],
  practiceName: string,
): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `${practiceName} inventory alert — ${skus.length} SKU${
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

  // Chrome comes from the shared CareMetric Breathe email design system.
  const html = renderBrandedEmail({
    // Tenant-scoped subject, so the wordmark must match it (same reason as
    // the PacWare digest). The PLATFORM_NAME digests correctly keep the
    // platform default.
    brandName: practiceName,
    brandTagline: "Inventory",
    heading: "Inventory alert",
    preheader: `${skus.length} product${
      skus.length === 1 ? "" : "s"
    } at or below threshold.`,
    contentHtml: [
      textParagraph(
        `${skus.length} product${skus.length === 1 ? "" : "s"} at or below threshold.`,
      ),
      `<table role="presentation" width="100%" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;">
<thead><tr>
<th style="padding:8px 12px;text-align:left;font-size:12px;color:${BREATHE_COLORS.muted};font-weight:600;border-bottom:1px solid ${BREATHE_COLORS.hairline};">Product</th>
<th style="padding:8px 12px;text-align:right;font-size:12px;color:${BREATHE_COLORS.muted};font-weight:600;border-bottom:1px solid ${BREATHE_COLORS.hairline};">On hand</th>
<th style="padding:8px 12px;text-align:right;font-size:12px;color:${BREATHE_COLORS.muted};font-weight:600;border-bottom:1px solid ${BREATHE_COLORS.hairline};">Threshold</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>`,
    ].join("\n"),
    footerLines: ["Adjust stock or thresholds in the admin inventory page."],
  });
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

/** Built once per tick and threaded into every per-tenant sweep. */
interface LowStockRunContext {
  stripe: ReturnType<typeof getStripeClient>;
  /** The seed/platform tenant — the one org that owns the platform catalog. */
  seedOrgId: string | null;
}

/**
 * Scan ONE tenant's Stripe catalog for low stock and alert ITS admins.
 * Extracted so the cron can fan out across active tenants. The catalog is
 * per-tenant under Stripe Connect (G5): the product list is routed to the
 * tenant's connected account via `stripeAccountRequestOptions(orgId)`. A
 * non-seed tenant with NO connected account owns no catalog of its own, so
 * it is skipped — it must not alert on the platform/seed catalog that isn't
 * theirs. The `low_stock_alert_state` dedup is per-tenant (org-scoped
 * client), and recipients are the tenant's own active super-admins (env
 * fallback). Mutates the shared aggregate `stats`.
 */
async function lowStockAlertsForOrg(
  orgId: string,
  ctx: LowStockRunContext,
  stats: LowStockAlertStats,
): Promise<void> {
  const { stripe, seedOrgId } = ctx;

  // Stripe Connect (G5): route the catalog read to the tenant's connected
  // account. NULL account → {} → the platform account. A non-seed tenant
  // without a connected account has no catalog yet, so skip rather than scan
  // (and alert on) the platform catalog that belongs to the seed tenant.
  const accountOpts = await stripeAccountRequestOptions(orgId);
  if (orgId !== seedOrgId && !accountOpts.stripeAccount) {
    return;
  }

  // Page through every active product. The catalog is small (dozens) so this
  // is usually one round-trip, but we MUST page rather than `limit: 100` once
  // — otherwise SKUs beyond page 1 are never scanned and an in-progress alert
  // can never resolve. Hard cap at 10 pages (1000 products) as a defense bound.
  const products: ShopProductView[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 10; page++) {
    const list = await stripe.products.list(
      {
        active: true,
        limit: 100,
        expand: ["data.default_price"],
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      },
      accountOpts,
    );
    for (const p of list.data) {
      const projected = projectProduct(p);
      if (projected) products.push(projected);
    }
    if (!list.has_more || list.data.length === 0) break;
    startingAfter = list.data[list.data.length - 1]!.id;
  }
  stats.scanned += products.length;

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
  stats.belowThreshold += below.length;

  const supabase = getOrgScopedClient(orgId);
  const nowIso = new Date().toISOString();
  const cooldownCutoff = new Date(
    Date.now() - ALERT_COOLDOWN_HOURS * 60 * 60 * 1000,
  ).toISOString();

  // Resolve recovered SKUs: stamp last_resolved_at where a row exists
  // and has an unresolved last_alerted_at. This is the gate that lets
  // the next dip alert again.
  if (recoveredIds.length > 0) {
    const { data: resolved, error: resolveErr } = await supabase
      .from("low_stock_alert_state")
      .update({ last_resolved_at: nowIso, updated_at: nowIso })
      .in("product_id", recoveredIds)
      .is("last_resolved_at", null)
      .not("last_alerted_at", "is", null)
      .select("product_id");
    if (resolveErr) {
      logger.warn(
        { err: resolveErr },
        "low-stock-alerts: failed to mark resolved",
      );
    } else {
      stats.resolved += (resolved ?? []).length;
    }
  }

  if (below.length === 0) {
    logger.info(
      { event: "shop-inventory.low-stock-alerts.no_alerts", org_id: orgId },
      "low-stock-alerts: no SKUs below threshold",
    );
    return;
  }

  // Decide which below-threshold SKUs are actually alert-eligible
  // (never alerted, or recovered since last alert, or cooldown expired).
  const belowIds = below.map((b) => b.productId);
  const { data: stateRows, error: stateErr } = await supabase
    .from("low_stock_alert_state")
    .select("product_id, last_alerted_at, last_resolved_at")
    .in("product_id", belowIds);
  if (stateErr) {
    throw new Error(
      `low-stock-alerts state lookup failed: ${stateErr.message}`,
    );
  }
  const stateById = new Map(
    (
      (stateRows ?? []) as Array<{
        product_id: string;
        last_alerted_at: string | null;
        last_resolved_at: string | null;
      }>
    ).map((r) => [
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
    if (state.lastResolvedAt && state.lastResolvedAt > state.lastAlertedAt) {
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
  stats.newAlerts += alertable.length;

  if (alertable.length === 0) {
    logger.info(
      {
        event: "shop-inventory.low-stock-alerts.suppressed",
        org_id: orgId,
        belowThreshold: below.length,
      },
      "low-stock-alerts: all below-threshold SKUs are within cooldown",
    );
    return;
  }

  // Slack ops digest (best-effort, non-PHI: SKU names + stock vs threshold).
  // Fires for the tenant whenever there are alertable SKUs, independent of
  // email config.
  void notifyOpsDigest({
    orgId,
    severity: "warning",
    title: `🟠 Low stock — ${alertable.length} SKU(s)`,
    lines: alertable
      .slice(0, 10)
      .map((s) => `• ${s.name}: ${s.stockCount}/${s.threshold}`),
  });

  // Per-tenant recipients: the org's own active super-admins, falling back to
  // the platform RESUPPLY_ADMIN_EMAILS allowlist when the tenant has none.
  const recipients = await resolveSuperAdminRecipients(supabase);
  stats.recipients += recipients.length;
  if (recipients.length === 0) {
    logger.warn(
      {
        event: "shop-inventory.low-stock-alerts.no_recipients",
        org_id: orgId,
        wouldAlert: alertable.length,
      },
      "low-stock-alerts: no tenant recipients (admins or env); no email sent",
    );
    // Still upsert state so we don't repeatedly compute the same
    // alertable set without actually delivering anything.
    await upsertAlertState(orgId, alertable, nowIso);
    return;
  }

  let sendgrid;
  try {
    sendgrid = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      logger.warn(
        { event: "shop-inventory.low-stock-alerts.email_unconfigured", err },
        "low-stock-alerts: email not configured; skipping send",
      );
      return;
    }
    throw err;
  }

  // Brand the subject with THIS tenant's name — the recipients are this
  // tenant's admins. The miss/error fallback is the PLATFORM name, not the
  // process-global RESUPPLY_PRACTICE_NAME it used to be: that carries the
  // SEED tenant's brand, so a DB blip put the seed's name on another
  // tenant's inventory alert.
  const brand = await resolveTenantBrandName(supabase, orgId, PLATFORM_NAME);
  const { subject, html, text } = renderDigest(alertable, brand);
  let anySent = false;
  for (const to of recipients) {
    try {
      await sendgrid.sendEmail({ to, subject, html, text });
      anySent = true;
    } catch (err) {
      logger.warn(
        { to, err },
        "low-stock-alerts: send failed for one recipient",
      );
    }
  }
  stats.emailSent = stats.emailSent || anySent;

  // Even on partial send failure, stamp state so the next tick
  // honours the cooldown for the SKUs we tried to alert on. The
  // worst case is a 24h re-attempt for SKUs whose alerts didn't
  // reach anyone — acceptable vs hammering SendGrid every 6h.
  await upsertAlertState(orgId, alertable, nowIso);
}

/**
 * Scan EVERY active tenant's catalog for low stock. Builds the Stripe client
 * once, resolves the seed tenant, then fans out per tenant with per-tenant
 * failure isolation (`forEachActiveOrg`) — routing each catalog read to the
 * tenant's connected account and alerting its own admins. The returned stats
 * are aggregated across tenants.
 */
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
  const seedOrgId = await resolveSeedOrgId();
  if (!seedOrgId) {
    // Fail-soft: without the seed org we can't attribute the platform catalog
    // to a tenant, so the seed/platform catalog is skipped this tick (the gate
    // below treats every org as non-seed). Connected tenants still alert on
    // their own accounts. Log so this degraded tick isn't silent.
    logger.warn(
      { event: "shop-inventory.low-stock-alerts.no_seed_org" },
      "low-stock-alerts: seed org unresolved — platform catalog skipped this tick (connected tenants unaffected)",
    );
  }
  await forEachActiveOrg(
    async (orgId) => {
      await lowStockAlertsForOrg(orgId, { stripe, seedOrgId }, stats);
    },
    { jobName: ALERT_JOB },
  );

  return stats;
}

/**
 * The tenant's customer-facing brand for the alert subject. Reads the org's
 * storefront/legal name from the GLOBAL organizations directory via `.raw()`
 * (the org-scoped facade would wrongly filter that table), falling back to
 * the platform name on any miss/error so a DB blip never blocks the alert
 * (and never substitutes another tenant's brand).
 */
async function resolveTenantBrandName(
  supabase: OrgScopedClient,
  orgId: string,
  fallback: string,
): Promise<string> {
  try {
    const { data, error } = await supabase
      .raw()
      .schema("resupply")
      .from("organizations")
      .select("storefront_name, name")
      .eq("id", orgId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const row = data as {
      storefront_name: string | null;
      name: string | null;
    } | null;
    return row?.storefront_name?.trim() || row?.name?.trim() || fallback;
  } catch (err) {
    logger.warn(
      {
        event: "shop-inventory.low-stock-alerts.brand_lookup_failed",
        err,
        org_id: orgId,
      },
      "low-stock-alerts: tenant brand lookup failed; using the platform name",
    );
    return fallback;
  }
}

async function upsertAlertState(
  orgId: string,
  alertable: BelowThresholdSku[],
  nowIso: string,
): Promise<void> {
  const supabase = getOrgScopedClient(orgId);
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
    .from("low_stock_alert_state")
    // (org_id, product_id) PK (migration 0373) — the org-scoped facade
    // injects org_id, so the conflict target must include it. Two connected
    // Stripe accounts can share a product id; conflicting on product_id alone
    // would overwrite the OTHER tenant's alert state.
    .upsert(rows, { onConflict: "org_id,product_id" });
  if (error) {
    logger.warn({ err: error }, "low-stock-alerts: state upsert failed");
  }
}

export async function registerLowStockAlertsJob(boss: PgBoss): Promise<void> {
  await createQueueWithDlq(boss, ALERT_JOB, VENDOR_SEND_QUEUE_OPTS);
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

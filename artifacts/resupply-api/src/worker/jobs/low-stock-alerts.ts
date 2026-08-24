// pg-boss job: scan the product catalog every 6 hours and send a digest
// email to admin staff for every SKU whose on-hand count has fallen at or
// below its reorder point.
//
// The catalog moved from Stripe to Postgres (migration 0520) when patient
// card payments were retired. The dedup model below is unchanged — only the
// source of the counts differs, and the key is now the warehouse SKU rather
// than a Stripe product id.
//
// Why a digest (not one email per SKU):
//   Even on a tight catalog (~30 SKUs) a "one alert per SKU per dip"
//   pattern can flood an inbox during a busy week. Operators want a
//   single rollup they can scan in 10 seconds.
//
// Dedup model — see migration 0142:
//   resupply.low_stock_alert_state holds one row per SKU (the column is
//   still named `product_id`; it now carries the SKU) with
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
// An empty catalog is a no-op, not an error: a tenant that hasn't
// registered any SKUs yet simply has nothing to alert on.

import type PgBoss from "pg-boss";

import {
  getOrgScopedClient,
  type OrgScopedClient,
} from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";

import { resolveSuperAdminRecipients } from "../../lib/admin-assistant/adminAssistantTools";
import { listTrackedProducts, type ProductView } from "../../lib/catalog/store";
import { logger } from "../../lib/logger";
import { notifyOpsDigest } from "../../lib/slack/notify";
import { forEachActiveOrg } from "../lib/for-each-active-org.js";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";
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
// The reorder-point default lives with the catalog so the admin badge and
// this digest can never disagree about what "low" means.

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
  sku: string;
  name: string;
  stockCount: number;
  threshold: number;
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
    "Manage inventory: /admin/catalog",
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

/**
 * Scan ONE tenant's catalog for low stock and alert ITS admins. Extracted
 * so the cron can fan out across active tenants. `products` is org-scoped,
 * so a tenant can only ever see (and alert on) its own SKUs — the property
 * the Stripe-Connect account routing used to provide. The
 * `low_stock_alert_state` dedup is per-tenant too, and recipients are the
 * tenant's own active super-admins (env fallback). Mutates the shared
 * aggregate `stats`.
 */
async function lowStockAlertsForOrg(
  orgId: string,
  stats: LowStockAlertStats,
): Promise<void> {
  // Only TRACKED SKUs come back — an untracked one has no count to compare
  // and must never alert. Unpaged: we need the whole set to distinguish a
  // SKU that recovered from one that was never low.
  const products: ProductView[] = await listTrackedProducts(orgId);
  stats.scanned += products.length;

  // Two buckets:
  //   below — products currently at/below threshold (eligible to alert)
  //   recovered — products with an open alert row that are now ABOVE
  //               their threshold (we stamp last_resolved_at so the
  //               next dip is treated as a fresh alert)
  const below: BelowThresholdSku[] = [];
  const recoveredSkus: string[] = [];

  for (const p of products) {
    // Defensive: listTrackedProducts already excludes these.
    if (p.stockCount === null || p.lowStockThreshold === null) continue;
    if (p.lowStock) {
      below.push({
        sku: p.sku,
        name: p.name,
        stockCount: p.stockCount,
        threshold: p.lowStockThreshold,
      });
    } else {
      recoveredSkus.push(p.sku);
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
  if (recoveredSkus.length > 0) {
    const { data: resolved, error: resolveErr } = await supabase
      .from("low_stock_alert_state")
      .update({ last_resolved_at: nowIso, updated_at: nowIso })
      .in("product_id", recoveredSkus)
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
  const belowSkus = below.map((b) => b.sku);
  const { data: stateRows, error: stateErr } = await supabase
    .from("low_stock_alert_state")
    .select("product_id, last_alerted_at, last_resolved_at")
    .in("product_id", belowSkus);
  if (stateErr) {
    throw new Error(
      `low-stock-alerts state lookup failed: ${stateErr.message}`,
    );
  }
  const stateBySku = new Map(
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
    const state = stateBySku.get(sku.sku);
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
 * Scan EVERY active tenant's catalog for low stock, fanning out with
 * per-tenant failure isolation (`forEachActiveOrg`) so one tenant's bad
 * data can't stop the sweep. Each tenant reads its own org-scoped catalog
 * and alerts its own admins. The returned stats are aggregated.
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

  await forEachActiveOrg(
    async (orgId) => {
      await lowStockAlertsForOrg(orgId, stats);
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
    product_id: sku.sku,
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
    // injects org_id, so the conflict target must include it. Two tenants
    // can stock the same SKU; conflicting on product_id alone would
    // overwrite the OTHER tenant's alert state.
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

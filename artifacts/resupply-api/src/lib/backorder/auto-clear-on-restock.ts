// Auto-clear open backorders for a SKU that just came back in stock.
//
// The resupply order-flow substitutes (or queues) a SKU while it has an open
// `shop_backorders` row (resolve-fulfillment-sku.ts). Today a CSR clears that
// row by hand (routes/admin/shop-backorders.ts) — so a SKU can stay "on
// backorder" (and keep getting substituted away) after stock is actually
// back. This closes the loop: when the admin shop-inventory editor raises a
// product's stock from 0 → positive, the same transition that fires the
// back-in-stock notify queue also clears any open backorder for that
// product's `metadata.shop_sku`.
//
// Idempotent (only touches rows with `cleared_at IS NULL`, with a re-guard on
// the update for the concurrent case) and FAIL-SOFT (never throws — a clear
// failure must never break the inventory save that triggered it). The clear
// is recorded under the same `resupply.backorder.cleared` audit action as a
// manual clear, tagged `auto: true`.
//
// PHI posture: deals only in SKU strings + row ids; logs neither patient data
// nor order contents.

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../logger";

export interface AutoClearBackorderInput {
  orgId: string;
  /** The resupply SKU (a product's `metadata.shop_sku`) that's back in stock. */
  sku: string;
  actorEmail?: string | null;
  actorUserId?: string | null;
}

export interface AutoClearBackorderResult {
  cleared: number;
}

export async function autoClearBackorderForSku(
  input: AutoClearBackorderInput,
): Promise<AutoClearBackorderResult> {
  const result: AutoClearBackorderResult = { cleared: 0 };
  const sku = input.sku?.trim();
  if (!sku) return result;

  try {
    const supabase = getOrgScopedClient(input.orgId);

    const { data: open, error: readErr } = await supabase
      .from("shop_backorders")
      .select("id, notes")
      .eq("sku", sku)
      .is("cleared_at", null);
    if (readErr) throw readErr;

    const rows = (open ?? []) as Array<{ id: string; notes: string | null }>;
    if (rows.length === 0) return result;

    const nowIso = new Date().toISOString();
    for (const row of rows) {
      const mergedNotes = row.notes
        ? `${row.notes}\n— auto-cleared: back in stock`
        : "auto-cleared: back in stock";
      const { error: updErr } = await supabase
        .from("shop_backorders")
        .update({ cleared_at: nowIso, notes: mergedNotes })
        .eq("id", row.id)
        // Re-guard so a concurrent manual clear can't be double-stamped.
        .is("cleared_at", null);
      if (updErr) {
        logger.warn(
          { err: updErr, sku, id: row.id },
          "backorder-auto-clear: update failed (non-fatal)",
        );
        continue;
      }
      result.cleared += 1;
      await logAudit({
        action: "resupply.backorder.cleared",
        adminEmail: input.actorEmail ?? null,
        adminUserId: input.actorUserId ?? null,
        targetTable: "shop_backorders",
        targetId: row.id,
        metadata: { sku, auto: true, reason: "back_in_stock" },
        ip: null,
        userAgent: null,
      }).catch((err) => {
        logger.warn(
          { err },
          "resupply.backorder.cleared (auto) audit write failed",
        );
      });
    }

    if (result.cleared > 0) {
      logger.info(
        { sku, cleared: result.cleared },
        "backorder-auto-clear: cleared on restock",
      );
    }
    return result;
  } catch (err) {
    logger.warn({ err, sku }, "backorder-auto-clear: failed (non-fatal)");
    return result;
  }
}

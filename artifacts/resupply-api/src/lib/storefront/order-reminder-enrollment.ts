// order-reminder-enrollment.ts — bridge cash-pay storefront purchases
// into the replacement-reminder engine (#4).
//
// Storefront (cash-pay) orders and the insurance resupply pipeline
// (episodes/claims) are deliberately separate funnels — we do NOT
// create insurance episodes from a cash-pay sale. But a customer who
// buys CPAP consumables still needs to reorder them on a cadence, and
// today nothing enrolls them. This connects the two cleanly: on a
// paid order, auto-enroll the buyer in the SAME `reminder_subscriptions`
// system the public /reminders opt-in uses, seeded with the consumables
// they just bought at their standard replacement cadence.
//
// CONSENT NOTE: auto-enrolling a buyer into recurring reminder emails
// is a consent decision (CAN-SPAM / practice policy). It is therefore
// feature-flagged and SEEDED DISABLED — an operator turns it on after a
// consent review. Reminders are email-only and every subscription
// carries a manage/unsubscribe token. We also NEVER re-enroll an email
// that previously unsubscribed.
//
// Fail-soft: the caller (Stripe webhook) wraps this so a failure never
// breaks order finalization.

import { randomBytes } from "node:crypto";

import {
  getSupabaseServiceRoleClient,
  type Json,
} from "@workspace/resupply-db";

import { isFeatureEnabled } from "../feature-flags";
import { logger } from "../logger";
import { ReminderItemSku } from "../api-zod/generated/types/reminderItemSku";
import type { ReminderItem } from "../api-zod/generated/types/reminderItem";

/** Stored item shape (ReminderItem + the computed next-due date). */
export type StoredReminderItem = ReminderItem & { nextDueAt: string };

/** Standard consumer replacement cadence per canonical SKU (days). */
export const SKU_DEFAULT_INTERVAL_DAYS: Record<ReminderItemSku, number> = {
  maskCushion: 30,
  maskFrameHeadgear: 90,
  headgear: 180,
  tubing: 90,
  disposableFilter: 30,
  reusableFilter: 180,
  waterChamber: 180,
};

/**
 * Infer the canonical reminder SKU from a free-text product name.
 * Returns null for non-consumables (machines, wipes, accessories) so
 * we don't create a meaningless reorder reminder. Order matters: an
 * explicit "cushion" wins over a generic "mask", and a full-mask kit
 * ("... mask") maps to the frame rather than the cushion.
 */
export function inferReminderSku(name: string): ReminderItemSku | null {
  const n = name.toLowerCase();
  if (/cushion/.test(n)) return ReminderItemSku.maskCushion;
  if (/headgear/.test(n) && !/mask/.test(n)) return ReminderItemSku.headgear;
  if (/chamber|humidifier/.test(n)) return ReminderItemSku.waterChamber;
  if (/tubing|\bhose\b/.test(n)) return ReminderItemSku.tubing;
  if (/filter/.test(n)) {
    return /reusable|non-disposable|foam/.test(n)
      ? ReminderItemSku.reusableFilter
      : ReminderItemSku.disposableFilter;
  }
  if (/pillow/.test(n) && !/mask/.test(n)) return ReminderItemSku.maskCushion;
  if (/mask|frame/.test(n)) return ReminderItemSku.maskFrameHeadgear;
  return null;
}

/** today (YYYY-MM-DD, UTC) + days → YYYY-MM-DD. */
function addDaysIso(isoDate: string, days: number): string {
  const base = new Date(`${isoDate}T00:00:00Z`).getTime();
  return new Date(base + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export interface OrderLineItemLike {
  name: string;
}

/**
 * Turn the purchased line items into reminder items — one per distinct
 * consumable SKU, seeded "last replaced today" with the standard
 * cadence. Pure + deterministic given `today`.
 */
export function buildReminderItemsFromOrder(
  lineItems: ReadonlyArray<OrderLineItemLike>,
  today: string,
): StoredReminderItem[] {
  const bySku = new Map<ReminderItemSku, StoredReminderItem>();
  for (const li of lineItems) {
    const sku = inferReminderSku(li.name);
    if (!sku || bySku.has(sku)) continue;
    const intervalDays = SKU_DEFAULT_INTERVAL_DAYS[sku];
    bySku.set(sku, {
      sku,
      lastReplacedAt: today,
      intervalDays,
      nextDueAt: addDaysIso(today, intervalDays),
    });
  }
  return [...bySku.values()];
}

/** Merge incoming items into existing ones, keyed by sku (existing wins). */
export function mergeReminderItems(
  existing: ReadonlyArray<StoredReminderItem>,
  incoming: ReadonlyArray<StoredReminderItem>,
): StoredReminderItem[] {
  const present = new Set(existing.map((i) => i.sku));
  return [...existing, ...incoming.filter((i) => !present.has(i.sku))];
}

export interface AutoEnrollInput {
  email: string;
  lineItems: ReadonlyArray<OrderLineItemLike>;
  now?: Date;
  log?: { warn?: (obj: unknown, msg?: string) => void } | null;
}

export interface AutoEnrollResult {
  enrolled: boolean;
  reason:
    | "ok_inserted"
    | "ok_merged"
    | "disabled"
    | "no_consumables"
    | "unsubscribed"
    | "no_change";
}

/**
 * Enroll the buyer in replacement reminders for the consumables on a
 * paid order. Flag-gated + opt-out-respecting. Never throws — returns a
 * tagged result the caller can log.
 */
export async function autoEnrollReminderFromOrder(
  input: AutoEnrollInput,
): Promise<AutoEnrollResult> {
  if (!(await isFeatureEnabled("storefront.auto_reminder_enrollment"))) {
    return { enrolled: false, reason: "disabled" };
  }

  const now = input.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const items = buildReminderItemsFromOrder(input.lineItems, today);
  if (items.length === 0) return { enrolled: false, reason: "no_consumables" };

  const email = input.email.trim().toLowerCase();
  const supabase = getSupabaseServiceRoleClient();

  const { data: existing, error: lookupErr } = await supabase
    .schema("public")
    .from("reminder_subscriptions")
    .select("email, status, items")
    .eq("email", email)
    .limit(1)
    .maybeSingle();
  if (lookupErr) throw lookupErr;

  if (existing) {
    // Respect a prior unsubscribe — never silently re-enroll.
    if (existing.status !== "active") {
      return { enrolled: false, reason: "unsubscribed" };
    }
    const current = (existing.items ?? []) as unknown as StoredReminderItem[];
    const merged = mergeReminderItems(current, items);
    if (merged.length === current.length) {
      return { enrolled: false, reason: "no_change" };
    }
    const { error: updErr } = await supabase
      .schema("public")
      .from("reminder_subscriptions")
      .update({
        items: merged as unknown as Json,
        updated_at: now.toISOString(),
      })
      .eq("email", email);
    if (updErr) throw updErr;
    return { enrolled: true, reason: "ok_merged" };
  }

  const { error: insErr } = await supabase
    .schema("public")
    .from("reminder_subscriptions")
    .insert({
      email,
      manage_token: randomBytes(32).toString("hex"),
      items: items as unknown as Json,
      status: "active",
      updated_at: now.toISOString(),
    });
  // A concurrent insert (same email) loses the unique race with 23505 —
  // treat as benign; the winner already enrolled this email.
  if (insErr && (insErr as { code?: string }).code !== "23505") {
    throw insErr;
  }
  return { enrolled: insErr ? false : true, reason: "ok_inserted" };
}

/** Thin wrapper used by the webhook so the call site stays tidy. */
export async function tryAutoEnrollReminderFromOrder(
  input: AutoEnrollInput,
): Promise<void> {
  try {
    const result = await autoEnrollReminderFromOrder(input);
    if (result.enrolled) {
      logger.info(
        { event: "storefront.reminder_enroll", reason: result.reason },
        "storefront: auto-enrolled buyer in replacement reminders",
      );
    }
  } catch (err) {
    (input.log?.warn ?? logger.warn.bind(logger))(
      {
        event: "storefront.reminder_enroll_failed",
        errName: err instanceof Error ? err.name : "unknown",
      },
      "storefront: replacement-reminder auto-enroll failed (non-fatal)",
    );
  }
}

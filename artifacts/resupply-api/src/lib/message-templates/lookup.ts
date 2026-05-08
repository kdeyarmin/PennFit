// Render-path lookup function for the customer-message template
// library. This is the API-side bridge between
// `@workspace/resupply-templates`'s `renderMessage(req, fallback,
// lookup)` and the actual Drizzle queries.
//
// Two tables, queried in order:
//
//   1. shop_customer_message_template_overrides (Phase 3) — the
//      sparse per-customer override table. Override fields are
//      independently nullable so a partial override INHERITS the
//      not-overridden fields from the global. isActive=false on the
//      override means "suppress this customer entirely for this
//      (template_key, channel)" — we return a synthetic
//      MessageTemplate with empty body strings so the renderer
//      produces a no-op send (the dispatcher decides whether to
//      skip vs. send-empty; today every dispatcher with a "skip
//      empty" branch will skip).
//
//   2. message_templates (Phase 1) — the global library row at
//      (template_key, channel).
//
// Either table missing → the catch returns null and renderMessage
// falls back to the call-site baseline. This is the property that
// makes the migrations forward-deploy-safe even before they're
// journaled.

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import {
  getDbPool,
  messageTemplates,
  shopCustomerMessageTemplateOverrides,
  type MessageTemplateRow,
  type ShopCustomerMessageTemplateOverrideRow,
} from "@workspace/resupply-db";
import {
  type Channel,
  type MessageTemplate,
  type TemplateLookup,
} from "@workspace/resupply-templates";

import { logger } from "../logger";

/** Validate channel values that come back from raw SQL. */
function asChannel(s: string): Channel | null {
  if (s === "email" || s === "sms" || s === "voice" || s === "push") return s;
  return null;
}

/**
 * Build a MessageTemplate by layering an override (if any) on top
 * of the global row. Override fields that are null inherit from the
 * global. isActive=false on the override produces an empty-body
 * synthetic — see the file header for the dispatcher contract.
 */
function applyOverride(
  global: MessageTemplateRow | null,
  override: ShopCustomerMessageTemplateOverrideRow | null,
): MessageTemplate | null {
  if (!override && !global) return null;

  const channel = asChannel((override ?? global!).channel);
  if (!channel) return null;

  // Override exists but is disabled → suppress: synthesize an
  // empty-body template. Allowed-variables list comes from the
  // global if there is one (so the editor + render path keep their
  // contract); empty array if there's no global yet.
  if (override && !override.isActive) {
    return {
      templateKey: override.templateKey,
      channel,
      subject: null,
      bodyHtml: null,
      bodyText: "",
      allowedVariables: global?.allowedVariables ?? [],
    };
  }

  // No global: use the override fields as-is. (Shouldn't normally
  // happen — admins create overrides only after the global exists —
  // but the schema doesn't enforce it, so we behave correctly.)
  if (!global) {
    return {
      templateKey: override!.templateKey,
      channel,
      subject: override!.subject,
      bodyHtml: override!.bodyHtml,
      bodyText: override!.bodyText ?? "",
      allowedVariables: [],
    };
  }

  // Global is disabled → treat as missing (fallback path will run).
  if (!global.isActive) return null;

  if (!override) {
    return {
      templateKey: global.templateKey,
      channel,
      subject: global.subject,
      bodyHtml: global.bodyHtml,
      bodyText: global.bodyText,
      allowedVariables: global.allowedVariables ?? [],
    };
  }

  // Both exist + override active: layer per-field.
  return {
    templateKey: global.templateKey,
    channel,
    subject: override.subject ?? global.subject,
    bodyHtml: override.bodyHtml ?? global.bodyHtml,
    bodyText: override.bodyText ?? global.bodyText,
    allowedVariables: global.allowedVariables ?? [],
  };
}

/**
 * The TemplateLookup implementation the API artifact passes to
 * `renderMessage`. Use this from every dispatcher that wants the
 * template library + per-customer override behaviour. Renders
 * gracefully degrade to the call-site baseline if either table is
 * missing — see the file header.
 */
export const messageTemplateLookup: TemplateLookup = async (
  templateKey,
  channel,
  customerId,
) => {
  try {
    const db = drizzle(getDbPool());

    // Two queries (override + global) issued in parallel. Both are
    // small unique-index hits; joining them server-side would
    // marginally win on round-trips but lose on readability.
    const [overrideRows, globalRows] = await Promise.all([
      customerId
        ? db
            .select()
            .from(shopCustomerMessageTemplateOverrides)
            .where(
              and(
                eq(
                  shopCustomerMessageTemplateOverrides.customerId,
                  customerId,
                ),
                eq(
                  shopCustomerMessageTemplateOverrides.templateKey,
                  templateKey,
                ),
                eq(
                  shopCustomerMessageTemplateOverrides.channel,
                  channel,
                ),
              ),
            )
            .limit(1)
        : Promise.resolve([] as ShopCustomerMessageTemplateOverrideRow[]),
      db
        .select()
        .from(messageTemplates)
        .where(
          and(
            eq(messageTemplates.templateKey, templateKey),
            eq(messageTemplates.channel, channel),
          ),
        )
        .limit(1),
    ]);

    return applyOverride(globalRows[0] ?? null, overrideRows[0] ?? null);
  } catch (err) {
    // DB outage, missing tables (migrations not applied yet),
    // network blip. Log once at debug so we know it's happening
    // without spamming on every cron tick. The render path's
    // fallback is the safety net.
    logger.debug(
      {
        event: "message_template_lookup_failed",
        template_key: templateKey,
        channel,
        err: err instanceof Error ? err.message : String(err),
      },
      "message-template lookup failed; renderMessage will use the call-site fallback",
    );
    return null;
  }
};

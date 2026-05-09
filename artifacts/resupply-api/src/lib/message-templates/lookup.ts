// Render-path lookup function for the customer-message template
// library. This is the API-side bridge between
// `@workspace/resupply-templates`'s `renderMessage(req, fallback,
// lookup)` and the actual Supabase queries.
//
// Two tables, queried in parallel:
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

import {
  getSupabaseServiceRoleClient,
  type Database,
} from "@workspace/resupply-db";
import {
  type Channel,
  type MessageTemplate,
  type TemplateLookup,
} from "@workspace/resupply-templates";

import { logger } from "../logger";

type MessageTemplateRow =
  Database["resupply"]["Tables"]["message_templates"]["Row"];
type OverrideRow =
  Database["resupply"]["Tables"]["shop_customer_message_template_overrides"]["Row"];

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
  override: OverrideRow | null,
): MessageTemplate | null {
  if (!override && !global) return null;

  const channel = asChannel((override ?? global!).channel);
  if (!channel) return null;

  // Override exists but is disabled → suppress: synthesize an
  // empty-body template. Allowed-variables list comes from the
  // global if there is one (so the editor + render path keep their
  // contract); empty array if there's no global yet.
  if (override && !override.is_active) {
    return {
      templateKey: override.template_key,
      channel,
      subject: null,
      bodyHtml: null,
      bodyText: "",
      allowedVariables: global?.allowed_variables ?? [],
    };
  }

  // No global: use the override fields as-is. (Shouldn't normally
  // happen — admins create overrides only after the global exists —
  // but the schema doesn't enforce it, so we behave correctly.)
  if (!global) {
    return {
      templateKey: override!.template_key,
      channel,
      subject: override!.subject,
      bodyHtml: override!.body_html,
      bodyText: override!.body_text ?? "",
      allowedVariables: [],
    };
  }

  // Global is disabled → treat as missing (fallback path will run).
  if (!global.is_active) return null;

  if (!override) {
    return {
      templateKey: global.template_key,
      channel,
      subject: global.subject,
      bodyHtml: global.body_html,
      bodyText: global.body_text,
      allowedVariables: global.allowed_variables ?? [],
    };
  }

  // Both exist + override active: layer per-field.
  return {
    templateKey: global.template_key,
    channel,
    subject: override.subject ?? global.subject,
    bodyHtml: override.body_html ?? global.body_html,
    bodyText: override.body_text ?? global.body_text,
    allowedVariables: global.allowed_variables ?? [],
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
    const supabase = getSupabaseServiceRoleClient();

    // Two queries (override + global) issued in parallel. Both are
    // small unique-index hits; PostgREST has no JOIN, so we resolve
    // each side separately and merge JS-side via applyOverride.
    const [overrideRes, globalRes] = await Promise.all([
      customerId
        ? supabase
            .schema("resupply")
            .from("shop_customer_message_template_overrides")
            .select(
              "id, customer_id, template_key, channel, subject, body_html, body_text, is_active, note, created_by, updated_by, created_at, updated_at",
            )
            .eq("customer_id", customerId)
            .eq("template_key", templateKey)
            .eq("channel", channel)
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null as null }),
      supabase
        .schema("resupply")
        .from("message_templates")
        .select(
          "id, template_key, channel, subject, body_html, body_text, allowed_variables, is_active, updated_at, updated_by, created_at, created_by",
        )
        .eq("template_key", templateKey)
        .eq("channel", channel)
        .limit(1)
        .maybeSingle(),
    ]);
    if (overrideRes.error) throw overrideRes.error;
    if (globalRes.error) throw globalRes.error;

    return applyOverride(globalRes.data ?? null, overrideRes.data ?? null);
  } catch (err) {
    // DB outage, missing tables (migrations not applied yet),
    // network blip. Log once at debug so we know it's happening
    // without spamming on every cron tick. The render path's
    // fallback is the safety net.
    const errCode =
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      typeof err.code === "string"
        ? err.code
        : undefined;

    logger.debug(
      {
        event: "message_template_lookup_failed",
        template_key: templateKey,
        channel,
        err,
        errCategory: errCode ? "db_query_error" : "template_lookup_error",
        errCode,
      },
      "message-template lookup failed; renderMessage will use the call-site fallback",
    );
    return null;
  }
};

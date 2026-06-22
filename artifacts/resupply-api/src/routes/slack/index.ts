// Slack inbound endpoints — interactivity (button clicks) + slash commands.
//
//   POST /resupply-api/slack/interactivity  — Block Kit button callbacks
//   POST /resupply-api/slack/commands       — the /pennfit slash command
//
// Both are signature-verified Slack webhooks, NOT admin-cookie routes — the
// gate is the Slack request signature (HMAC over the raw body), exactly like
// the SendGrid/Twilio webhooks. The raw Buffer is captured in app.ts BEFORE
// the global express.json() (Slack posts application/x-www-form-urlencoded,
// so a parsed body could never be re-serialized for verification).
//
// Posture:
//   * Signing secret unset            → 503 (inbound not configured).
//   * slack.interactivity flag off    → 200 ack with an ephemeral notice.
//   * Bad/stale/missing signature     → 401.
//   * Action performed best-effort; an ephemeral confirmation is posted back
//     via Slack's response_url (fire-and-forget).
//
// PHI: request/response text stays non-PHI (ids + counts), same rule as the
// outbound notifier.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";
import {
  readSlackSigningSecretOrNull,
  verifySlackSignature,
} from "@workspace/resupply-integrations-slack";

import { getEffectiveEnv } from "../../lib/app-config/store";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { safeAudit } from "../../lib/messaging/safe-audit";
import { ESCALATE_ACTION_ID, SNOOZE_ACTION_ID } from "../../lib/slack/notify";

const router: IRouter = Router();

type ConversationPriority = "low" | "normal" | "high" | "urgent";
const PRIORITY_RANK: Record<ConversationPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

/** Pull the raw body bytes (captured by express.raw in app.ts) as a string. */
function rawBodyString(body: unknown): string {
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (typeof body === "string") return body;
  return "";
}

/**
 * Verify the Slack signature over the raw body. Returns the config status so
 * the handler can map it to 503 (unconfigured) / 401 (bad signature) / ok.
 */
async function verify(
  req: Parameters<Parameters<IRouter["post"]>[1]>[0],
): Promise<"ok" | "unconfigured" | "bad_signature"> {
  const signingSecret = readSlackSigningSecretOrNull(await getEffectiveEnv());
  if (!signingSecret) return "unconfigured";
  const ok = verifySlackSignature({
    signingSecret,
    signatureHeader: req.header("x-slack-signature"),
    timestampHeader: req.header("x-slack-request-timestamp"),
    rawBody: rawBodyString(req.body),
  });
  return ok ? "ok" : "bad_signature";
}

/** Best-effort ephemeral reply via Slack's response_url. Never throws. */
async function respondViaUrl(responseUrl: string, text: string): Promise<void> {
  try {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text }),
    });
  } catch (err) {
    logger.warn(
      { event: "slack_response_url_failed", err: errInfo(err) },
      "slack: response_url post failed (ignored)",
    );
  }
}

function errInfo(err: unknown): { name: string; message?: string } {
  return err instanceof Error
    ? { name: err.name, message: err.message.slice(0, 200) }
    : { name: "unknown" };
}

// ── Interactivity (button clicks) ────────────────────────────────────
const blockActionsSchema = z.object({
  type: z.literal("block_actions"),
  response_url: z.string().url().optional(),
  user: z.object({ id: z.string() }).partial().optional(),
  actions: z
    .array(
      z.object({
        action_id: z.string(),
        value: z.string().optional(),
      }),
    )
    .min(1),
});

router.post("/slack/interactivity", async (req, res) => {
  const status = await verify(req);
  if (status === "unconfigured") {
    res.status(503).json({ error: "slack_not_configured" });
    return;
  }
  if (status === "bad_signature") {
    res.status(401).json({ error: "bad_signature" });
    return;
  }

  if (!(await isFeatureEnabled("slack.interactivity"))) {
    res.status(200).json({
      response_type: "ephemeral",
      text: "Slack actions are disabled.",
    });
    return;
  }

  // Slack interactivity arrives as form-urlencoded with a `payload` JSON field.
  const params = new URLSearchParams(rawBodyString(req.body));
  const rawPayload = params.get("payload");
  if (!rawPayload) {
    res.status(400).json({ error: "missing_payload" });
    return;
  }
  let payload: z.infer<typeof blockActionsSchema>;
  try {
    payload = blockActionsSchema.parse(JSON.parse(rawPayload));
  } catch {
    // Not an interaction we handle (or malformed) — ACK so Slack doesn't retry.
    res.status(200).end();
    return;
  }

  const action = payload.actions[0];
  // ACK immediately; do the work after. Slack requires a fast 200.
  res.status(200).end();

  if (action?.action_id === ESCALATE_ACTION_ID && action.value) {
    await handleEscalate(action.value, payload.response_url ?? null);
  } else if (action?.action_id === SNOOZE_ACTION_ID && action.value) {
    await handleSnooze(action.value, payload.response_url ?? null);
  }
});

/**
 * Escalate a conversation from a Slack button. No Slack-user→admin identity
 * mapping yet, so this is an UNATTRIBUTED escalation (escalation_reason
 * "slack_action") — it surfaces the thread in the inbox's escalated view
 * without claiming it for a specific rep. Idempotent: a thread already
 * escalated is left as-is. Platform-scoped (seed org), matching the rest of
 * the Slack integration.
 */
async function handleEscalate(
  conversationId: string,
  responseUrl: string | null,
): Promise<void> {
  try {
    const orgId = await resolveSeedOrgId();
    if (!orgId) return;
    const supabase = getOrgScopedClient(orgId);

    const { data: row, error: readErr } = await supabase
      .from("conversations")
      .select("id, priority, escalated_at")
      .eq("id", conversationId)
      .limit(1)
      .maybeSingle();
    if (readErr) throw readErr;
    if (!row) {
      if (responseUrl)
        await respondViaUrl(responseUrl, "That conversation was not found.");
      return;
    }
    if (row.escalated_at) {
      if (responseUrl)
        await respondViaUrl(
          responseUrl,
          "That conversation is already escalated. ✅",
        );
      return;
    }

    const current = (row.priority as ConversationPriority | null) ?? "normal";
    const next: ConversationPriority =
      PRIORITY_RANK[current] < PRIORITY_RANK.high ? "high" : current;
    const nowIso = new Date().toISOString();
    const { data: updated, error: updErr } = await supabase
      .from("conversations")
      .update({
        escalated_at: nowIso,
        escalation_reason: "slack_action",
        priority: next,
        updated_at: nowIso,
      })
      .eq("id", conversationId)
      .is("escalated_at", null) // guard a concurrent escalation
      .select("id");
    if (updErr) throw updErr;
    if (!updated || updated.length === 0) {
      if (responseUrl)
        await respondViaUrl(
          responseUrl,
          "That conversation is already escalated. ✅",
        );
      return;
    }

    await safeAudit({
      action: "messaging.handoff.escalated",
      adminEmail: null,
      adminUserId: null,
      targetTable: "conversations",
      targetId: conversationId,
      metadata: { conversation_id: conversationId, source: "slack_action" },
      ip: null,
      userAgent: null,
    });

    logger.info(
      { event: "slack_escalate_ok", conversationId },
      "slack: conversation escalated via interactivity",
    );
    if (responseUrl)
      await respondViaUrl(
        responseUrl,
        "Escalated — it's at the top of the queue. ✅",
      );
  } catch (err) {
    logger.warn(
      { event: "slack_escalate_failed", conversationId, err: errInfo(err) },
      "slack: escalate action failed",
    );
    if (responseUrl)
      await respondViaUrl(responseUrl, "Sorry — that didn't go through.");
  }
}

/** How long a Slack "Snooze" defers a conversation. */
const SNOOZE_MS = 24 * 60 * 60 * 1000;

/**
 * Snooze a conversation from a Slack button: stamp `snoozed_until` so it
 * drops out of the default inbox views until the window passes. No identity
 * mapping needed. A closed thread is left alone. Platform-scoped (seed org).
 */
async function handleSnooze(
  conversationId: string,
  responseUrl: string | null,
): Promise<void> {
  try {
    const orgId = await resolveSeedOrgId();
    if (!orgId) return;
    const supabase = getOrgScopedClient(orgId);

    const { data: row, error: readErr } = await supabase
      .from("conversations")
      .select("id, status")
      .eq("id", conversationId)
      .limit(1)
      .maybeSingle();
    if (readErr) throw readErr;
    if (!row) {
      if (responseUrl)
        await respondViaUrl(responseUrl, "That conversation was not found.");
      return;
    }
    if (row.status === "closed") {
      if (responseUrl)
        await respondViaUrl(
          responseUrl,
          "That conversation is already closed.",
        );
      return;
    }

    const nowIso = new Date().toISOString();
    const { error: updErr } = await supabase
      .from("conversations")
      .update({
        snoozed_until: new Date(Date.now() + SNOOZE_MS).toISOString(),
        updated_at: nowIso,
      })
      .eq("id", conversationId);
    if (updErr) throw updErr;

    await safeAudit({
      action: "messaging.conversation.snoozed",
      adminEmail: null,
      adminUserId: null,
      targetTable: "conversations",
      targetId: conversationId,
      metadata: { conversation_id: conversationId, source: "slack_action" },
      ip: null,
      userAgent: null,
    });

    logger.info(
      { event: "slack_snooze_ok", conversationId },
      "slack: conversation snoozed via interactivity",
    );
    if (responseUrl) await respondViaUrl(responseUrl, "Snoozed for a day. 💤");
  } catch (err) {
    logger.warn(
      { event: "slack_snooze_failed", conversationId, err: errInfo(err) },
      "slack: snooze action failed",
    );
    if (responseUrl)
      await respondViaUrl(responseUrl, "Sorry — that didn't go through.");
  }
}

// ── Slash command: /pennfit [queue] ──────────────────────────────────
router.post("/slack/commands", async (req, res) => {
  const status = await verify(req);
  if (status === "unconfigured") {
    res.status(503).json({ error: "slack_not_configured" });
    return;
  }
  if (status === "bad_signature") {
    res.status(401).json({ error: "bad_signature" });
    return;
  }
  if (!(await isFeatureEnabled("slack.interactivity"))) {
    res.status(200).json({
      response_type: "ephemeral",
      text: "Slack commands are disabled.",
    });
    return;
  }

  const params = new URLSearchParams(rawBodyString(req.body));
  const text = (params.get("text") ?? "").trim().toLowerCase();
  // Only "queue" (or empty) is supported today.
  if (text && text !== "queue") {
    res.status(200).json({
      response_type: "ephemeral",
      text: "Usage: `/pennfit queue` — shows unassigned + SLA-breaching conversations.",
    });
    return;
  }

  const summary = await queueSummary();
  res.status(200).json({ response_type: "ephemeral", text: summary });
});

/** Non-PHI queue snapshot for the slash command. Best-effort. */
async function queueSummary(): Promise<string> {
  try {
    const orgId = await resolveSeedOrgId();
    if (!orgId) return "Queue unavailable right now.";
    const supabase = getOrgScopedClient(orgId);

    const unassigned = await supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .in("status", ["open", "awaiting_admin"])
      .is("assigned_admin_user_id", null);

    const soonIso = new Date(Date.now() + 30 * 60_000).toISOString();
    const breaching = await supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .in("status", ["open", "awaiting_admin"])
      .not("sla_due_at", "is", null)
      .lte("sla_due_at", soonIso);

    const u = unassigned.count ?? 0;
    const b = breaching.count ?? 0;
    return `*CS queue*\n• Unassigned: *${u}*\n• Breaching SLA (≤30m or overdue): *${b}*`;
  } catch (err) {
    logger.warn(
      { event: "slack_queue_summary_failed", err: errInfo(err) },
      "slack: queue summary failed",
    );
    return "Queue unavailable right now.";
  }
}

export default router;

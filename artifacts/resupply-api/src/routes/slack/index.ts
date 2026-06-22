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
// PER-TENANT: each tenant connects its OWN Slack app. The inbound request
// carries a workspace `team_id` (untrusted) which we map → orgId via the
// tenant's stored SLACK_TEAM_ID, then verify the request with THAT tenant's
// signing secret and act in THAT tenant's scope. A forged team_id just selects
// a secret the signature won't match. No team_id match → seed org
// (single-tenant back-compat).
//
// Posture:
//   * No tenant / signing secret unset → 503 (inbound not configured).
//   * slack.interactivity flag off     → 200 ack with an ephemeral notice.
//   * Bad/stale/missing signature      → 401.
//   * Action best-effort; an ephemeral confirmation is posted back via Slack's
//     response_url (fire-and-forget).
//
// PHI: request/response text stays non-PHI (ids + counts), same rule as the
// outbound notifier.

import { Router, type IRouter, type Request } from "express";
import { z } from "zod";

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";
import {
  readSlackSigningSecretOrNull,
  verifySlackSignature,
} from "@workspace/resupply-integrations-slack";

import { getEffectiveEnvForOrg } from "../../lib/app-config/store";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { safeAudit } from "../../lib/messaging/safe-audit";
import {
  CLAIM_ACTION_ID,
  ESCALATE_ACTION_ID,
  SNOOZE_ACTION_ID,
} from "../../lib/slack/notify";
import { resolveOrgIdBySlackTeamId } from "../../lib/slack/team-resolver";

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
 * Extract the Slack workspace team_id from an UNVERIFIED raw body — slash
 * commands carry it as a form field, interactivity inside the `payload` JSON.
 * Untrusted: it only selects which tenant's signing secret to verify against.
 */
function extractTeamId(rawBody: string): string | null {
  const params = new URLSearchParams(rawBody);
  const direct = params.get("team_id");
  if (direct) return direct;
  const payload = params.get("payload");
  if (payload) {
    try {
      const p = JSON.parse(payload) as { team?: { id?: string } };
      return p.team?.id ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

type AuthResult =
  | { status: "ok"; orgId: string }
  | { status: "unconfigured" }
  | { status: "bad_signature" };

/**
 * Resolve the owning tenant by team_id, then verify the request with THAT
 * tenant's signing secret. Returns the orgId on success so handlers act in the
 * right tenant's scope.
 */
async function authenticate(req: Request): Promise<AuthResult> {
  const raw = rawBodyString(req.body);
  const teamId = extractTeamId(raw);
  const orgId =
    (teamId ? await resolveOrgIdBySlackTeamId(teamId) : null) ??
    (await resolveSeedOrgId());
  if (!orgId) return { status: "unconfigured" };

  // Same resolution as the outbound notifier: tenant overlay over process.env,
  // so both UI-entered (app_config) and env-var config are honored.
  const env = await getEffectiveEnvForOrg(orgId);
  const signingSecret = readSlackSigningSecretOrNull(env);
  if (!signingSecret) return { status: "unconfigured" };

  const ok = verifySlackSignature({
    signingSecret,
    signatureHeader: req.header("x-slack-signature"),
    timestampHeader: req.header("x-slack-request-timestamp"),
    rawBody: raw,
  });
  return ok ? { status: "ok", orgId } : { status: "bad_signature" };
}

/** Map an auth failure to its HTTP response. Returns true if handled. */
function rejectIfNotOk(
  auth: AuthResult,
  res: Parameters<Parameters<IRouter["post"]>[1]>[1],
): auth is { status: "unconfigured" } | { status: "bad_signature" } {
  if (auth.status === "unconfigured") {
    res.status(503).json({ error: "slack_not_configured" });
    return true;
  }
  if (auth.status === "bad_signature") {
    res.status(401).json({ error: "bad_signature" });
    return true;
  }
  return false;
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
  const auth = await authenticate(req);
  if (rejectIfNotOk(auth, res)) return;
  const { orgId } = auth;

  if (!(await isFeatureEnabled("slack.interactivity", orgId))) {
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

  if (action?.action_id === CLAIM_ACTION_ID && action.value) {
    await handleClaim(
      orgId,
      action.value,
      payload.user?.id ?? null,
      payload.response_url ?? null,
    );
  } else if (action?.action_id === ESCALATE_ACTION_ID && action.value) {
    await handleEscalate(orgId, action.value, payload.response_url ?? null);
  } else if (action?.action_id === SNOOZE_ACTION_ID && action.value) {
    await handleSnooze(orgId, action.value, payload.response_url ?? null);
  }
});

/**
 * Claim a conversation from a Slack button — assign it to the rep who clicked.
 * The clicking Slack user is mapped to an admin_users row by `slack_user_id`
 * (set on the Team settings page) WITHIN this tenant. Unlinked Slack users get
 * a prompt to link their account; an already-claimed thread is left as-is.
 */
async function handleClaim(
  orgId: string,
  conversationId: string,
  slackUserId: string | null,
  responseUrl: string | null,
): Promise<void> {
  try {
    if (!slackUserId) return;
    const supabase = getOrgScopedClient(orgId);

    const { data: admin, error: adminErr } = await supabase
      .from("admin_users")
      .select("id, status")
      .eq("slack_user_id", slackUserId)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    if (adminErr) throw adminErr;
    if (!admin) {
      if (responseUrl)
        await respondViaUrl(
          responseUrl,
          "Your Slack account isn't linked yet — ask an admin to add your Slack user id on the Team settings page.",
        );
      return;
    }

    const { data: row, error: readErr } = await supabase
      .from("conversations")
      .select("id, assigned_admin_user_id")
      .eq("id", conversationId)
      .limit(1)
      .maybeSingle();
    if (readErr) throw readErr;
    if (!row) {
      if (responseUrl)
        await respondViaUrl(responseUrl, "That conversation was not found.");
      return;
    }
    if (row.assigned_admin_user_id && row.assigned_admin_user_id !== admin.id) {
      if (responseUrl)
        await respondViaUrl(
          responseUrl,
          "Someone else already claimed that one.",
        );
      return;
    }
    if (row.assigned_admin_user_id === admin.id) {
      if (responseUrl)
        await respondViaUrl(responseUrl, "You've already got that one. ✅");
      return;
    }

    const nowIso = new Date().toISOString();
    const { data: updated, error: updErr } = await supabase
      .from("conversations")
      .update({
        assigned_admin_user_id: admin.id,
        assigned_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", conversationId)
      .is("assigned_admin_user_id", null) // guard a concurrent claim
      .select("id");
    if (updErr) throw updErr;
    if (!updated || updated.length === 0) {
      if (responseUrl)
        await respondViaUrl(responseUrl, "Someone else just claimed that one.");
      return;
    }

    await safeAudit({
      action: "messaging.conversation.assigned",
      adminEmail: null,
      adminUserId: admin.id,
      targetTable: "conversations",
      targetId: conversationId,
      metadata: { conversation_id: conversationId, source: "slack_action" },
      ip: null,
      userAgent: null,
    });

    logger.info(
      { event: "slack_claim_ok", conversationId },
      "slack: conversation claimed via interactivity",
    );
    if (responseUrl)
      await respondViaUrl(responseUrl, "Claimed — it's yours. ✅");
  } catch (err) {
    logger.warn(
      { event: "slack_claim_failed", conversationId, err: errInfo(err) },
      "slack: claim action failed",
    );
    if (responseUrl)
      await respondViaUrl(responseUrl, "Sorry — that didn't go through.");
  }
}

/**
 * Escalate a conversation from a Slack button. Unattributed (escalation_reason
 * "slack_action") — it surfaces the thread in the inbox's escalated view.
 * Idempotent: a thread already escalated is left as-is.
 */
async function handleEscalate(
  orgId: string,
  conversationId: string,
  responseUrl: string | null,
): Promise<void> {
  try {
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
 * drops out of the default inbox views until the window passes. A closed
 * thread is left alone.
 */
async function handleSnooze(
  orgId: string,
  conversationId: string,
  responseUrl: string | null,
): Promise<void> {
  try {
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
  const auth = await authenticate(req);
  if (rejectIfNotOk(auth, res)) return;
  const { orgId } = auth;

  if (!(await isFeatureEnabled("slack.interactivity", orgId))) {
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

  const summary = await queueSummary(orgId);
  res.status(200).json({ response_type: "ephemeral", text: summary });
});

/** Non-PHI queue snapshot for the slash command. Best-effort. */
async function queueSummary(orgId: string): Promise<string> {
  try {
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

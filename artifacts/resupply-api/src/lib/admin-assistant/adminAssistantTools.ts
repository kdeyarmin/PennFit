/**
 * Tools for the admin program-manager chatbot (PennPilot).
 *
 * PennPilot has exactly one tool: `suggest_feature`. When the
 * conversation surfaces a genuine product gap, the model (after
 * confirming with the operator — see the prompt's TOOLS_GUIDE) calls
 * this tool to email a structured suggestion to the business
 * owner / super-admin(s).
 *
 * Recipient resolution (most-reliable first):
 *   1. Active super-admins in `resupply.admin_users` (role='admin',
 *      status='active') — these are the explicit owners.
 *   2. Fallback to the `RESUPPLY_ADMIN_EMAILS` env allowlist (the
 *      display-only owner list operators already configure).
 * If neither yields a recipient, the tool returns a soft failure so
 * PennPilot can tell the operator it couldn't send (rather than the
 * chat erroring out).
 *
 * Email always funnels through `@workspace/resupply-email`'s
 * `createSendgridClient()` (the one-From-address rule). When SendGrid
 * isn't configured the tool degrades to a soft failure — the chat
 * never throws.
 *
 * Tool shape mirrors the storefront chat tools (OpenAI function-tool
 * JSON) so the route's existing OpenAI⇄Anthropic conversion works
 * unchanged.
 */

import { z } from "zod";

import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";
import type { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../logger.js";

/** Cap tool rounds per user turn so a runaway model can't recurse. */
export const MAX_ADMIN_TOOL_ROUNDS = 2;

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

/** Per-request context the route hands to the tool dispatcher. */
export interface AdminAssistantToolContext {
  supabase: SupabaseClient;
  /** Email of the operator filing the suggestion (used as Reply-To). */
  suggestingAdminEmail: string | null;
  /** Coarse role of the operator filing the suggestion. */
  suggestingAdminRole: "admin" | "agent" | null;
}

/** Result envelope — `ok` plus a small JSON-serialisable payload. */
export interface AdminToolResult {
  ok: boolean;
  /** Machine-readable outcome for the model to phrase in plain English. */
  data: Record<string, unknown>;
}

/** OpenAI-shaped tool definition. Converted to Anthropic shape by the route. */
export const ADMIN_ASSISTANT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "suggest_feature",
      description:
        "Email a structured product/feature suggestion to the business owner / super-admins. ALWAYS confirm with the operator before calling this — never send silently. Use only for genuine gaps or improvements, not for features the app already has. Never include patient PHI.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: {
            type: "string",
            description: "Short headline for the idea (a few words).",
          },
          problem: {
            type: "string",
            description:
              "The concrete pain or gap in the operator's own terms — what they were trying to do and where the app fell short.",
          },
          proposal: {
            type: "string",
            description:
              "What to build or change to solve the problem. Specific and self-contained.",
          },
          area: {
            type: "string",
            description:
              "Optional. The part of the app it touches, e.g. Billing, Patients, Orders, Analytics, Integrations, Messaging.",
          },
          priority: {
            type: "string",
            enum: ["low", "medium", "high"],
            description:
              "Optional. Your read on how much this would help operators.",
          },
        },
        required: ["title", "problem", "proposal"],
      },
    },
  },
] as const;

const suggestFeatureArgsSchema = z.object({
  title: z.string().trim().min(3).max(160),
  problem: z.string().trim().min(5).max(4_000),
  proposal: z.string().trim().min(5).max(4_000),
  area: z.string().trim().max(120).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
});

/**
 * Resolve the super-admin recipient list. Prefers the explicit
 * `admin_users` super-admin rows; falls back to the
 * `RESUPPLY_ADMIN_EMAILS` allowlist. De-duplicates and lower-cases.
 */
export async function resolveSuperAdminRecipients(
  supabase: SupabaseClient,
): Promise<string[]> {
  const out = new Set<string>();
  try {
    const { data, error } = await supabase
      .schema("resupply")
      .from("admin_users")
      .select("email_lower")
      .eq("role", "admin")
      .eq("status", "active");
    if (error) throw error;
    for (const row of data ?? []) {
      const email = (row as { email_lower?: string }).email_lower?.trim();
      if (email) out.add(email.toLowerCase());
    }
  } catch (err) {
    logger.warn(
      {
        event: "admin_assistant_recipient_lookup_failed",
        err: err instanceof Error ? { name: err.name } : { name: "unknown" },
      },
      "admin assistant: admin_users super-admin lookup failed; falling back to env",
    );
  }

  if (out.size === 0) {
    const envList = process.env.RESUPPLY_ADMIN_EMAILS ?? "";
    for (const raw of envList.split(",")) {
      const email = raw.trim().toLowerCase();
      // Cheap shape check — a comma-list with a stray blank or label
      // shouldn't become a recipient.
      if (email && email.includes("@")) out.add(email);
    }
  }
  return [...out];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildSuggestionEmail(
  args: z.infer<typeof suggestFeatureArgsSchema>,
  fromAdmin: string | null,
  fromRole: string | null,
): { subject: string; text: string; html: string } {
  const area = args.area ?? "(unspecified)";
  const priority = args.priority ?? "(unset)";
  const submittedBy = fromAdmin
    ? `${fromAdmin}${fromRole ? ` (${fromRole})` : ""}`
    : "an admin-console user";

  // Subject carries NO PHI — it's a feature idea, never patient data.
  const subject = `PennPilot feature suggestion: ${args.title}`;

  const text = [
    `A new feature suggestion was submitted from the PennFit admin console via PennPilot.`,
    ``,
    `Title:    ${args.title}`,
    `Area:     ${area}`,
    `Priority: ${priority}`,
    `From:     ${submittedBy}`,
    ``,
    `Problem / gap:`,
    args.problem,
    ``,
    `Proposed change:`,
    args.proposal,
    ``,
    `— Sent by PennPilot, the in-app program-manager assistant.`,
  ].join("\n");

  const html = [
    `<div style="font-family:system-ui,Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a;line-height:1.5">`,
    `<p>A new feature suggestion was submitted from the PennFit admin console via <strong>PennPilot</strong>.</p>`,
    `<table style="border-collapse:collapse;margin:12px 0">`,
    `<tr><td style="padding:2px 12px 2px 0;color:#64748b">Title</td><td><strong>${escapeHtml(args.title)}</strong></td></tr>`,
    `<tr><td style="padding:2px 12px 2px 0;color:#64748b">Area</td><td>${escapeHtml(area)}</td></tr>`,
    `<tr><td style="padding:2px 12px 2px 0;color:#64748b">Priority</td><td>${escapeHtml(priority)}</td></tr>`,
    `<tr><td style="padding:2px 12px 2px 0;color:#64748b">From</td><td>${escapeHtml(submittedBy)}</td></tr>`,
    `</table>`,
    `<p style="margin:12px 0 4px;color:#64748b">Problem / gap</p>`,
    `<p style="white-space:pre-wrap;margin:0 0 12px">${escapeHtml(args.problem)}</p>`,
    `<p style="margin:12px 0 4px;color:#64748b">Proposed change</p>`,
    `<p style="white-space:pre-wrap;margin:0 0 12px">${escapeHtml(args.proposal)}</p>`,
    `<hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0"/>`,
    `<p style="color:#94a3b8;font-size:12px;margin:0">Sent by PennPilot, the in-app program-manager assistant.</p>`,
    `</div>`,
  ].join("");

  return { subject, text, html };
}

/**
 * Execute the `suggest_feature` tool: validate args, resolve
 * recipients, send the email. Never throws — every failure path
 * returns `{ ok: false, data }` so the chat can surface a graceful
 * message and keep going.
 */
export async function executeAdminAssistantTool(
  name: string,
  rawArgs: unknown,
  ctx: AdminAssistantToolContext,
): Promise<AdminToolResult> {
  if (name !== "suggest_feature") {
    return { ok: false, data: { error: `Unknown tool: ${name}` } };
  }

  const parsed = suggestFeatureArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      data: {
        error: "invalid_arguments",
        details: parsed.error.issues.map(
          (i) => `${i.path.join(".")}: ${i.message}`,
        ),
      },
    };
  }
  const args = parsed.data;

  const recipients = await resolveSuperAdminRecipients(ctx.supabase);
  if (recipients.length === 0) {
    logger.warn(
      { event: "admin_assistant_no_recipients" },
      "admin assistant: no super-admin recipient could be resolved for feature suggestion",
    );
    return {
      ok: false,
      data: {
        error: "no_recipient",
        message:
          "No owner/super-admin email is configured to receive suggestions.",
      },
    };
  }

  let client;
  try {
    client = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      logger.warn(
        { event: "admin_assistant_email_unconfigured" },
        "admin assistant: SendGrid not configured; cannot send feature suggestion",
      );
      return {
        ok: false,
        data: {
          error: "email_unconfigured",
          message: "Email isn't configured in this environment.",
        },
      };
    }
    throw err;
  }

  const { subject, text, html } = buildSuggestionEmail(
    args,
    ctx.suggestingAdminEmail,
    ctx.suggestingAdminRole,
  );

  // Reply-To the submitting admin (when known) so the owner can reply
  // straight to the person with the idea. Skip a value with CR/LF (the
  // email client rejects those, but fail soft here).
  const replyTo =
    ctx.suggestingAdminEmail && !/[\r\n]/.test(ctx.suggestingAdminEmail)
      ? ctx.suggestingAdminEmail
      : undefined;

  const sent: string[] = [];
  for (const to of recipients) {
    try {
      await client.sendEmail({ to, subject, text, html, replyTo });
      sent.push(to);
    } catch (err) {
      // One bad recipient shouldn't sink the whole send; log and continue.
      const retryable = err instanceof EmailApiError ? err.retryable : null;
      logger.warn(
        {
          event: "admin_assistant_email_send_failed",
          retryable,
          err: err instanceof Error ? { name: err.name } : { name: "unknown" },
        },
        "admin assistant: failed to send a feature-suggestion email to a recipient",
      );
    }
  }

  if (sent.length === 0) {
    return {
      ok: false,
      data: {
        error: "send_failed",
        message: "The suggestion email could not be sent.",
      },
    };
  }

  logger.info(
    {
      event: "admin_assistant_feature_suggested",
      recipients: sent.length,
      area: args.area ?? null,
      priority: args.priority ?? null,
      titleChars: args.title.length,
    },
    "admin assistant: feature suggestion emailed to owner(s)",
  );

  return {
    ok: true,
    data: {
      sent: true,
      recipientCount: sent.length,
      title: args.title,
    },
  };
}

/** Serialise a tool result to the JSON string the model receives. */
export function serializeAdminToolResult(result: AdminToolResult): string {
  return JSON.stringify(result);
}

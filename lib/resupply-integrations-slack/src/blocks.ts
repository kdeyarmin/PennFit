// Block Kit message builders.
//
// These produce the JSON `blocks` arrays Slack renders. They are
// deliberately generic and PHI-agnostic: the caller decides what text to
// pass, and the resupply-api notifier layer is responsible for keeping that
// text non-PHI (a reference + status + a deep link — never message bodies,
// phone numbers, or clinical detail). See the PHI posture rule in CLAUDE.md.

export type SlackSeverity = "info" | "warning" | "critical";

/** A link button (no callback) — e.g. "Open in admin". */
export interface SlackLinkAction {
  kind: "link";
  text: string;
  url: string;
}

/**
 * A callback button. `actionId` routes to a handler in the inbound
 * interactivity endpoint; `value` carries the opaque target (e.g. a
 * conversation id). Never put PHI in either field — they round-trip
 * through Slack.
 */
export interface SlackButtonAction {
  kind: "button";
  text: string;
  actionId: string;
  value: string;
  style?: "primary" | "danger";
}

export type SlackAction = SlackLinkAction | SlackButtonAction;

export interface BuildAlertBlocksInput {
  /** Header line (e.g. "🟠 SLA breach"). */
  title: string;
  /** Body lines rendered as a single section, one per line. */
  lines: string[];
  /** Optional context footer (e.g. severity + timestamp), small grey text. */
  context?: string;
  /** Optional action row (link / callback buttons). */
  actions?: SlackAction[];
}

const SEVERITY_EMOJI: Record<SlackSeverity, string> = {
  info: "🔵",
  warning: "🟠",
  critical: "🔴",
};

/** Emoji prefix for a severity, for callers that build their own titles. */
export function severityEmoji(severity: SlackSeverity): string {
  return SEVERITY_EMOJI[severity];
}

/**
 * Build a Block Kit `blocks` array for an alert: a header, a body section,
 * an optional context footer, and an optional action row. Returns plain
 * JSON suitable for chat.postMessage's `blocks` field.
 */
export function buildAlertBlocks(input: BuildAlertBlocksInput): unknown[] {
  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: truncate(input.title, 150),
        emoji: true,
      },
    },
  ];

  const body = input.lines.filter((l) => l.trim().length > 0).join("\n");
  if (body) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(body, 2900) },
    });
  }

  if (input.actions && input.actions.length > 0) {
    blocks.push({
      type: "actions",
      elements: input.actions.map(toElement),
    });
  }

  if (input.context) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: truncate(input.context, 280) }],
    });
  }

  return blocks;
}

function toElement(action: SlackAction): unknown {
  if (action.kind === "link") {
    return {
      type: "button",
      text: { type: "plain_text", text: action.text, emoji: true },
      url: action.url,
    };
  }
  const el: Record<string, unknown> = {
    type: "button",
    text: { type: "plain_text", text: action.text, emoji: true },
    action_id: action.actionId,
    value: action.value,
  };
  if (action.style) el.style = action.style;
  return el;
}

/** Plain-text fallback string for clients that don't render blocks. */
export function buildFallbackText(input: BuildAlertBlocksInput): string {
  return truncate([input.title, ...input.lines].join(" — "), 280);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

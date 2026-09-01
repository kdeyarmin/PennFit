// Render ONE message about everything that changed in a scan.
//
// ONE MESSAGE, NOT ONE PER SIGNAL — AND NEVER ONE PER PATIENT
// -----------------------------------------------------------
// Eight separate emails arriving in the same minute get read as noise
// and filtered as a group. One message listing eight things gets read.
// The aggregation happens here rather than at the send site so there is
// exactly one place where "how many messages does a scan produce?" is
// answered, and the answer is "at most one per tenant, plus at most one
// for the platform".
//
// Per-patient alerting is not merely avoided, it is unreachable: the
// evaluator's inputs are counts, ages and ratios over populations, so
// there is no patient in scope by the time anything gets rendered.
//
// PHI: signal labels, statuses, numbers, and the bounded `detail` map —
// which collectors may only fill with counts and vocabulary strings.
// This body reaches SendGrid and Slack, both external services, so it is
// held to the same rule as a log line.

import type { LifecycleSignal } from "./signals";
import { formatSignalValue, type SignalEvaluation } from "./evaluate";
import type { AlertDecision } from "./alerts";

export interface DigestItem {
  signal: LifecycleSignal;
  evaluation: SignalEvaluation;
  decision: AlertDecision;
  /** How long this alert has been open, when it is not brand new. */
  openForHours: number | null;
}

export interface RenderedDigest {
  subject: string;
  text: string;
  html: string;
  /** One line per item, for the Slack digest. */
  lines: string[];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ACTION_VERB: Record<string, string> = {
  open: "NEW",
  escalate: "WORSE",
  renotify: "STILL",
  resolve: "CLEARED",
};

function age(hours: number | null): string {
  if (hours === null) return "";
  if (hours < 1) return " (just started)";
  if (hours < 48) return ` (open ${Math.round(hours)}h)`;
  return ` (open ${Math.round(hours / 24)} days)`;
}

/** One line: what, how bad, how far past the line, and for how long. */
export function renderLine(item: DigestItem): string {
  const { signal, evaluation, decision } = item;
  const verb = ACTION_VERB[decision.action] ?? decision.action.toUpperCase();
  if (decision.action === "resolve") {
    return `${verb} — ${signal.label}: ${decision.reason}`;
  }
  const value = formatSignalValue(evaluation.value, signal.unit);
  const threshold = formatSignalValue(
    evaluation.status === "failure"
      ? evaluation.failThreshold
      : evaluation.warnThreshold,
    signal.unit,
  );
  const truncated = evaluation.truncated
    ? " — this number is a FLOOR; the read hit its row cap"
    : "";
  return `${verb} ${evaluation.status.toUpperCase()} — ${signal.label}: ${value} (threshold ${threshold})${age(item.openForHours)}${truncated}`;
}

/**
 * The whole digest.
 *
 * `scopeLabel` names the tenant (or the platform) so a super-admin
 * watching several practices can tell whose problem this is without
 * opening it.
 */
export function renderDigest(input: {
  scopeLabel: string;
  items: readonly DigestItem[];
  consoleUrl: string;
  platformName: string;
}): RenderedDigest {
  const { scopeLabel, items, consoleUrl, platformName } = input;
  const failures = items.filter(
    (i) => i.evaluation.status === "failure" && i.decision.action !== "resolve",
  ).length;
  const warnings = items.filter(
    (i) => i.evaluation.status === "warning" && i.decision.action !== "resolve",
  ).length;
  const cleared = items.filter((i) => i.decision.action === "resolve").length;

  const headline =
    failures > 0
      ? `${failures} failing`
      : warnings > 0
        ? `${warnings} warning`
        : `${cleared} cleared`;
  const subject = `${platformName} lifecycle health — ${scopeLabel}: ${headline}`;

  const lines = items.map(renderLine);

  const text = [
    `${scopeLabel} — lifecycle health`,
    "",
    ...lines.map((l) => `• ${l}`),
    "",
    "Why each of these matters:",
    "",
    ...items.map((i) => `${i.signal.label}\n  ${i.signal.why}`),
    "",
    `Open the health panel: ${consoleUrl}`,
    "",
    "This is one message for the whole scan. Individual signals are never",
    "reported per patient, and an unchanged problem is reported at most",
    "once a day.",
  ].join("\n");

  const html = [
    `<p><strong>${escapeHtml(scopeLabel)}</strong> — lifecycle health</p>`,
    "<ul>",
    ...items.map((i) => {
      const colour =
        i.decision.action === "resolve"
          ? "#166534"
          : i.evaluation.status === "failure"
            ? "#991b1b"
            : "#92400e";
      return `<li style="margin-bottom:8px"><span style="color:${colour};font-weight:600">${escapeHtml(
        renderLine(i),
      )}</span><br><span style="color:#475569;font-size:13px">${escapeHtml(
        i.signal.why,
      )}</span></li>`;
    }),
    "</ul>",
    `<p><a href="${escapeHtml(consoleUrl)}">Open the health panel</a></p>`,
    `<p style="color:#64748b;font-size:12px">One message per scan. Signals are aggregate — never per patient — and an unchanged problem is repeated at most once a day.</p>`,
  ].join("\n");

  return { subject, text, html, lines };
}

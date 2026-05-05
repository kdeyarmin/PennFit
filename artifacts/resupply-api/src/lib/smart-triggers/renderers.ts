// Per-channel copy renderers for smart-trigger nudges.
//
// One file per channel-shape concern:
//   * subjectForKind / textBody / htmlBody — email body
//   * smsBody — single-segment ASCII (≤160 chars typical)
//   * pushBody — short toast (~110 chars to clear iOS/Android
//     lock-screen truncation)
//
// Lifted out of routes/admin/smart-triggers.ts so both the route
// handler and the daily pg-boss cron (Phase G.14) call the same
// copy. Future A/B testing of subject lines / CTAs lands here as
// a single edit that both surfaces pick up.
//
// PHI: no patient identifiers, no therapy values. Greeting + first
// name are passed by the caller after sanitization.

import { type TriggerKind } from "./index";

export function subjectForKind(kind: TriggerKind): string {
  switch (kind) {
    case "leak_rising":
      return "Your CPAP mask seal may need attention";
    case "usage_dropping":
      return "We noticed a few harder nights — anything we can help with?";
    case "cushion_wear":
      return "Your mask cushion may be wearing out";
    case "humidifier_drop":
      return "Time to refresh your tubing?";
  }
}

export function textBody(greeting: string, kind: TriggerKind): string {
  const safeGreeting = greeting.replace(/[<>&]/g, "");
  switch (kind) {
    case "leak_rising":
      return `${safeGreeting},\n\nYour mask leak rate has trended up over the last two weeks. The most common cause is a worn cushion seal — replacing it usually solves it overnight. If your insurance is on file, a replacement is already eligible.\n\nReply YES and we'll ship a fresh one. Or sign in at https://pennpaps.com/account to review options.\n\n— Penn Home Medical Supply\n`;
    case "usage_dropping":
      return `${safeGreeting},\n\nWe noticed your therapy hours have dropped over the last couple of weeks. That's the most common point where patients quietly stop using CPAP — and it's also the one where small changes (mask refit, ramp tweak, humidifier nudge) make the biggest difference.\n\nReply to this email and we'll set up a quick call. No charge, no pressure.\n\n— Penn Home Medical Supply\n`;
    case "cushion_wear":
      return `${safeGreeting},\n\nYour AHI and leak rate have both ticked up over the last two weeks — usually a sign your mask cushion is at the end of its life. A replacement cushion takes about 5 minutes to swap and typically clears both readings.\n\nReply YES to ship a fresh cushion (no charge if you're on insurance through us).\n\n— Penn Home Medical Supply\n`;
    case "humidifier_drop":
      return `${safeGreeting},\n\nWith warmer weather your tubing may be due for a refresh — older tubing collects condensation and reduces airflow, which can make therapy feel less comfortable in the summer.\n\nReply YES and we'll ship a fresh hose.\n\n— Penn Home Medical Supply\n`;
  }
}

export function htmlBody(greeting: string, kind: TriggerKind): string {
  const safeGreeting = greeting.replace(/[<>&]/g, "");
  const heading = subjectForKind(kind);
  const paragraphs = textBody(safeGreeting, kind)
    .split("\n\n")
    .map(
      (p) =>
        `<p style="margin:0 0 12px;font-size:14px;line-height:1.55;color:#0a1f44;">${p
          .replace(/[<>&]/g, "")
          .replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
  return `<!doctype html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; background: #f8fafc; padding: 24px;">
  <table cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #e2e8f0;">
    <tr><td style="padding:24px;">
      <h2 style="margin:0 0 16px;color:#0a1f44;font-size:18px;">${heading}</h2>
      ${paragraphs}
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Push-notification body. Short — push notifications get truncated
 * aggressively on iOS/Android lock screens (≈ 110 chars). Different
 * from the SMS variant (no STOP keyword; already gated by the
 * customer's browser permission) and different from the email body
 * (which can sustain a paragraph of context).
 */
export function pushBody(kind: TriggerKind): string {
  switch (kind) {
    case "leak_rising":
      return "Your mask leak rate has trended up. Tap to see what we noticed.";
    case "usage_dropping":
      return "We noticed your therapy hours dropping. We can help.";
    case "cushion_wear":
      return "Your AHI + leak both ticked up — tap for a fresh-cushion suggestion.";
    case "humidifier_drop":
      return "Your tubing may be due for a refresh.";
  }
}

/**
 * Render the SMS body for a smart-trigger nudge. Kept under 160
 * ASCII chars so the message ships as one Twilio segment in the
 * typical case (firstName + status + CTA). STOP keyword is included
 * so Twilio's opt-out compliance surface stays intact.
 *
 * Why short: SMS conversion drops sharply at multi-segment length;
 * the patient is one tap from "reply YES" so the body just needs to
 * carry the trigger reason and the CTA, not the long explanation
 * the email body uses.
 */
export function smsBody(firstName: string, kind: TriggerKind): string {
  const head = firstName ? `Hi ${firstName}` : "Hi";
  switch (kind) {
    case "leak_rising":
      return `${head}, your CPAP leak rate has trended up — usually means a worn cushion. Reply YES to ship a replacement, or STOP to opt out. — Penn Home`;
    case "usage_dropping":
      return `${head}, we noticed your therapy hours dropped lately. Small adjustments help. Reply YES for a quick check-in call, or STOP to opt out. — Penn Home`;
    case "cushion_wear":
      return `${head}, your AHI + leak rate are both up — usually a worn cushion. Reply YES to ship a fresh one, or STOP to opt out. — Penn Home`;
    case "humidifier_drop":
      return `${head}, your tubing may be due for a refresh. Reply YES to ship a fresh hose, or STOP to opt out. — Penn Home`;
  }
}

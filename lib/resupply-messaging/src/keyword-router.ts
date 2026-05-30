// @workspace/resupply-messaging — scripted SMS keyword router.
//
// First line of defense for inbound SMS. Parses common reply shapes
// without any LLM round-trip:
//   - Single-keyword replies ("YES", "Y", "STOP")
//   - Leading-keyword replies ("yes please", "no thanks")
//   - STOP/HELP keywords appearing anywhere in the body — carrier
//     compliance requires honoring these regardless of context.
//
// Anything we can't classify returns `intent: "unknown"`, and the
// caller hands the raw body to the AI fallback (see ai-fallback.ts
// for the adapter shape).
//
// Why a scripted router at all when we have an LLM available?
//   1. Cost. ~80% of replies will be "YES"/"NO"/"STOP" and a regex
//      handles each in microseconds at zero per-message cost.
//   2. Latency. Twilio expects a TwiML response within ~10s. A round
//      trip to an LLM adds 1–3s; the keyword path stays well under
//      100ms.
//   3. Auditability. Admins can re-derive a routing decision by
//      looking at the body — no model output to second-guess.
//   4. Carrier compliance. STOP / HELP MUST be honored. Sending the
//      decision through an LLM introduces a non-zero risk that the
//      model "reinterprets" a stop request as something else (e.g.
//      "stop sending so many" → confirm with edit). We refuse that
//      risk by handling the carrier-mandated keywords in code.
//
// US carrier rules also reserve UNSUBSCRIBE/QUIT/CANCEL/END/OPTOUT
// alongside STOP, and INFO alongside HELP. We treat them all as
// equivalent.

import type { Intent } from "./intents";

export interface KeywordRouterResult {
  intent: Intent;
  /** The original (untrimmed, original-case) body, echoed for logging. */
  raw: string;
  /** Lowercased + trimmed body, for the AI fallback's context window. */
  normalized: string;
  /**
   * How the decision was made. `keyword-anywhere` is the carrier-rule
   * matcher (STOP / HELP). `keyword-leading` is a first-word match
   * (YES / NO / EDIT). `unknown` means nothing matched and the caller
   * should escalate to the AI fallback.
   */
  matched: "keyword-anywhere" | "keyword-leading" | "unknown";
}

// Carrier-mandated set. CASE-INSENSITIVE, and we accept variants the
// CTIA / mobile carriers consider equivalent. Spanish equivalents
// (DETENER / CANCELAR / AYUDA) are included because T-Mobile and AT&T
// require carriers to honor Spanish opt-out keywords when the
// program reaches Spanish-speakers — failing to honor them is a
// compliance violation even when no Spanish-language sends went out.
const STOP_ANYWHERE = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
  "optout",
  "opt-out",
  // Spanish
  "detener",
  "cancelar",
  "alto",
  "fin",
  // Portuguese
  "parar",
]);

const HELP_ANYWHERE = new Set([
  "help",
  "info",
  "support",
  // Spanish
  "ayuda",
  // Portuguese
  "ajuda",
]);

// Carrier-reserved opt-in (re-subscribe) set. CTIA reserves START /
// UNSTOP as the counterpart to STOP. Unlike STOP we match these as a
// LEADING token only, not anywhere: over-honoring STOP is the safe
// error direction, but a spurious START matched mid-sentence
// ("yes, start shipping") would hijack a confirm and derail the order.
// `yes` is deliberately excluded — it's our confirm keyword.
const START_LEADING = new Set(["start", "unstop"]);

// Leading-keyword sets. Match only against the first 1–2 tokens so a
// freeform message that happens to contain "yes" mid-sentence
// ("did you say yes the last time?") doesn't get misrouted.
const CONFIRM_LEADING = new Set([
  "y",
  "yes",
  "yeah",
  "yep",
  "yea",
  "ok",
  "okay",
  "sure",
  "confirm",
  "confirmed",
]);

// Action verbs that read as "confirm" on their own ("ship it", "go",
// "send them") but are ambiguous when the reply is actually asking to
// change the destination ("send it to my new address"). We treat a
// leading action verb as confirm only when no address-change signal is
// present elsewhere in the body; otherwise it routes to edit_address.
const CONFIRM_ACTION_VERBS = new Set(["go", "send", "ship"]);

const DECLINE_LEADING = new Set([
  "n",
  "no",
  "nope",
  "nah",
  "decline",
  "skip",
  "pass",
]);

const EDIT_LEADING = new Set([
  "edit",
  "change",
  "address",
  "moved",
  "update",
  "wrong",
  "different",
]);

/**
 * Tokenize the body into lowercase word-chars only. Drops punctuation,
 * preserves order. Used so leading-keyword checks see "y." as "y" and
 * "no, thanks" as ["no", "thanks"].
 */
function tokenize(body: string): string[] {
  return body
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter(Boolean);
}

/**
 * Parse an inbound SMS body into a routing intent.
 *
 * Decision order:
 *   1. STOP-family anywhere → `stop`. Carriers require this.
 *   2. HELP-family anywhere → `help`. Carriers require this.
 *   3. First token is START/UNSTOP → `start` (carrier opt-in).
 *   4. First token matches confirm/decline/edit set → that intent
 *      (a leading action verb yields `edit_address` instead of
 *      `confirm` when the body also mentions an address change).
 *   5. Otherwise → `unknown` (caller escalates to AI fallback).
 */
export function parseSmsIntent(
  body: string | null | undefined,
): KeywordRouterResult {
  const raw = body ?? "";
  const normalized = raw.trim().toLowerCase();
  const tokens = tokenize(raw);

  // 1 + 2: carrier-mandated keywords, anywhere in the body.
  for (const token of tokens) {
    if (STOP_ANYWHERE.has(token)) {
      return { intent: "stop", raw, normalized, matched: "keyword-anywhere" };
    }
  }
  for (const token of tokens) {
    if (HELP_ANYWHERE.has(token)) {
      return { intent: "help", raw, normalized, matched: "keyword-anywhere" };
    }
  }

  // 3: carrier opt-in (START / UNSTOP), leading token only.
  const first = tokens[0];
  if (first) {
    if (START_LEADING.has(first)) {
      return { intent: "start", raw, normalized, matched: "keyword-leading" };
    }
  }

  // 4: leading-keyword for confirm/decline/edit.
  if (first) {
    const mentionsAddressChange = tokens.some((t) => EDIT_LEADING.has(t));
    if (CONFIRM_LEADING.has(first)) {
      return { intent: "confirm", raw, normalized, matched: "keyword-leading" };
    }
    // A leading action verb ("ship it", "go") confirms — unless the
    // reply is actually asking to change the address, in which case it
    // must not ship to the stale on-file address.
    if (CONFIRM_ACTION_VERBS.has(first)) {
      return mentionsAddressChange
        ? {
            intent: "edit_address",
            raw,
            normalized,
            matched: "keyword-leading",
          }
        : { intent: "confirm", raw, normalized, matched: "keyword-leading" };
    }
    if (DECLINE_LEADING.has(first)) {
      return { intent: "decline", raw, normalized, matched: "keyword-leading" };
    }
    if (EDIT_LEADING.has(first)) {
      return {
        intent: "edit_address",
        raw,
        normalized,
        matched: "keyword-leading",
      };
    }
  }

  // 4: nothing matched.
  return { intent: "unknown", raw, normalized, matched: "unknown" };
}

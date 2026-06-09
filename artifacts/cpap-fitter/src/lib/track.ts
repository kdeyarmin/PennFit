/**
 * Anonymous funnel-tracking helper.
 *
 * Generates a per-tab session id (random string, kept in sessionStorage so
 * it survives reloads but resets when the tab is closed), and POSTs funnel
 * events fire-and-forget. Failures are silent — tracking must NEVER block
 * or interfere with the patient flow.
 */

const SESSION_KEY = "pennpaps_track_session";

function getSessionId(): string {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : randomToken();
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    // private browsing or storage disabled — generate ephemeral id
    return randomToken();
  }
}

// Cryptographically-random token fallback for environments without
// crypto.randomUUID. We avoid Math.random — even for an anonymous
// session id collisions/predictability would skew funnel analytics
// and trip CodeQL's insecure-randomness rule.
function randomToken(): string {
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    let out = "";
    for (const byte of buf) {
      out += byte.toString(16).padStart(2, "0");
    }
    return out;
  }
  // Last-ditch fallback for ancient runtimes — timestamp-only is
  // not unique under burst, but the surrounding code only invokes
  // this when both sessionStorage AND crypto are unavailable, which
  // is effectively unreachable in supported browsers.
  const perfNow =
    typeof performance !== "undefined" ? performance.now().toString(36) : "0";
  return Date.now().toString(36) + "-" + perfNow;
}

export type TrackStep =
  | "home_view"
  | "consent_given"
  | "capture_started"
  | "capture_taken"
  | "measurements_extracted"
  | "measurement_error"
  | "questionnaire_completed"
  | "results_viewed"
  | "mask_chosen"
  | "order_started"
  | "order_submitted_success"
  | "cart_items_dropped"
  | "checkout_started"
  | "checkout_step_viewed"
  | "checkout_error"
  | "checkout_completed"
  | "reorder_prefill_applied"
  | "capture_blocked"
  | "results_retake_requested"
  | "chat_opened"
  | "chat_sent"
  | "chat_replied"
  | "chat_feedback"
  | "fitter_lead_submit_failed"
  | "fitter_invite_opened"
  | "fitter_invite_started"
  | "web_vital";

type MetadataForStep<T extends TrackStep> = T extends "capture_blocked"
  ? {
      // Mirrors `CaptureBlockers` from src/lib/capture-readiness.ts.
      // Earlier iterations also tracked face-orientation / lighting
      // blockers (noGlasses, evenLight, facingCamera), but the
      // capture flow now relies entirely on the iris-calibrated
      // measurement and only gates on camera readiness, so the
      // payload was narrowed to match what the helper actually
      // returns.
      cameraReady: boolean;
      runtimeReady?: boolean;
    }
  : T extends "results_retake_requested"
    ? { topConfidencePct: number }
    : T extends "chat_opened"
      ? { path: string }
      : T extends "chat_sent"
        ? { path: string; chars: number; suggested?: boolean }
        : T extends "chat_replied"
          ? {
              path: string;
              meta?: "offline" | "degraded" | "rate-limited" | "unavailable";
              durationMs: number;
            }
          : T extends "chat_feedback"
            ? { path: string; kind: "up" | "down" }
            : T extends "fitter_lead_submit_failed"
              ? {
                  // Low-cardinality bucket for graphing. "http_4xx" /
                  // "http_5xx" come from the parsed status; "network"
                  // covers fetch rejections (offline, DNS, connection
                  // reset); "other" is the catch-all for anything we
                  // couldn't categorise. Keeps the failure dashboard
                  // queryable without us storing arbitrary error text.
                  category: "http_4xx" | "http_5xx" | "network" | "other";
                  // The raw status when the fetch resolved; null when
                  // we never reached an HTTP response.
                  httpStatus: number | null;
                  // First 64 chars of the thrown Error.message. Used
                  // for incident drilldown only — the categories above
                  // are what dashboards group on. Truncated so an
                  // arbitrarily long server-side error string can't
                  // blow the 500-char track() payload cap.
                  errorCode: string;
                }
              : T extends "web_vital"
                ? {
                    name: "LCP" | "CLS" | "INP" | "FCP" | "TTFB";
                    value: number;
                    rating: "good" | "needs-improvement" | "poor";
                    navigationType: string;
                    path: string;
                  }
                : Record<string, unknown>;

export function track<T extends TrackStep>(
  step: T,
  metadata?: MetadataForStep<T>,
): void {
  // Fire-and-forget. Use the BASE_URL so this works behind path-based routing.
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const body = {
    sessionId: getSessionId(),
    step,
    metadata: metadata ? JSON.stringify(metadata).slice(0, 500) : undefined,
  };
  try {
    void fetch(`${base}/api/usage-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "include",
      keepalive: true,
    }).catch(() => {});
  } catch {
    // never throw
  }
}

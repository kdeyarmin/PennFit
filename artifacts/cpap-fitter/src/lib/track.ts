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
          : Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    // private browsing or storage disabled — generate ephemeral id
    return Math.random().toString(36).slice(2);
  }
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
  | "results_retake_requested";

type MetadataForStep<T extends TrackStep> = T extends "capture_blocked"
  ? {
      cameraReady: boolean;
      runtimeReady?: boolean;
      noGlasses: boolean;
      evenLight: boolean;
      facingCamera: boolean;
    }
  : T extends "results_retake_requested"
    ? { topConfidencePct: number }
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

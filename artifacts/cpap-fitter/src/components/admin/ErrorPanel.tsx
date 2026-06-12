import { ApiError } from "@workspace/api-client-react/admin";
import { Button } from "./Button";

// Inline error panel rendered when a list/detail query fails. Pulls a
// readable explanation off the generated client's ApiError when
// possible (zod validation surfaces structured `issues`); falls back
// to a generic message otherwise. Always offers a Retry button so an
// admin can recover from a transient blip without a full reload.

export function ErrorPanel({
  error,
  onRetry,
  title = "Couldn't load this view",
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}) {
  const { detail, statusLabel } = describeError(error);

  return (
    <div
      className="border rounded-lg p-5"
      style={{ backgroundColor: "#fef2f2", borderColor: "#fecaca" }}
      role="alert"
    >
      <p className="text-sm font-semibold mb-1" style={{ color: "#991b1b" }}>
        {title}
        {statusLabel && (
          <span
            className="ml-2 inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold"
            style={{ backgroundColor: "#fee2e2", color: "#991b1b" }}
          >
            {statusLabel}
          </span>
        )}
      </p>
      <p className="text-xs mb-3" style={{ color: "#7f1d1d" }}>
        {detail}
      </p>
      {onRetry && (
        <Button intent="secondary" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function describeError(error: unknown): {
  detail: string;
  statusLabel: string | null;
} {
  if (error instanceof ApiError) {
    const status = error.status;
    const statusLabel = status > 0 ? `HTTP ${status}` : null;

    // Validation errors carry { error: "invalid_query" | "invalid_body",
    // issues: [...] }; some routes also attach a human-readable `message`.
    const data = error.data as
      | {
          error?: string;
          message?: string;
          issues?: Array<{ path?: string; message?: string }>;
        }
      | null
      | undefined;

    if (
      (data?.error === "invalid_query" || data?.error === "invalid_body") &&
      data.issues &&
      data.issues.length
    ) {
      const first = data.issues[0];
      return {
        statusLabel,
        detail: `Invalid request: ${first.path ?? "field"} — ${first.message ?? "validation failed"}`,
      };
    }
    if (typeof data?.message === "string" && data.message.trim() !== "") {
      return { statusLabel, detail: truncate(data.message) };
    }
    if (status === 401)
      return {
        statusLabel,
        detail: "You appear to be signed out. Sign in and try again.",
      };
    if (status === 403)
      return { statusLabel, detail: "You don't have access to this view." };
    if (status === 404)
      return { statusLabel, detail: "The record was not found." };
    if (status >= 500)
      return {
        statusLabel,
        detail:
          "The server returned an error. Wait a moment, then retry; if it persists, contact ops.",
      };
    return {
      statusLabel,
      detail: error.message || "Request failed.",
    };
  }

  // Non-ApiError. Most hand-rolled admin API wrappers throw a plain Error
  // whose message already encodes the failure (often with an HTTP status,
  // e.g. "Failed to load analytics (500)" or "403 Forbidden"). Surface that
  // real message instead of assuming a connection problem — and reserve the
  // "check your connection" copy for genuine network-layer failures, where
  // fetch rejects with a TypeError and no HTTP response was ever received.
  if (isLikelyNetworkError(error)) {
    return {
      statusLabel: null,
      detail: "Network error. Check your connection and retry.",
    };
  }
  if (error instanceof Error && error.message.trim() !== "") {
    return {
      statusLabel: extractStatusLabel(error.message),
      detail: truncate(error.message),
    };
  }

  return {
    statusLabel: null,
    detail: "Request failed. Wait a moment, then retry.",
  };
}

// A genuine network-layer failure surfaces as a TypeError from fetch (the
// request never reached a server). Browsers vary the message, so match the
// known phrasings as a fallback for environments where the TypeError brand
// is lost (e.g. re-thrown across boundaries).
function isLikelyNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof Error) {
    return /\b(failed to fetch|networkerror|network request failed|load failed)\b/i.test(
      error.message,
    );
  }
  return false;
}

// Best-effort HTTP status extraction from a plain Error message so the panel
// can still show an "HTTP nnn" badge. Recognises "HTTP 500", "(500)",
// "status 500", and a leading "500 …". Returns null when no plausible code
// is present (avoids badging unrelated numbers).
function extractStatusLabel(message: string): string | null {
  const match =
    message.match(/\bHTTP (\d{3})\b/) ??
    message.match(/\((\d{3})\)/) ??
    message.match(/\bstatus[:\s]+(\d{3})\b/i) ??
    message.match(/^(\d{3})\b/);
  if (!match) return null;
  const code = Number(match[1]);
  return code >= 100 && code <= 599 ? `HTTP ${code}` : null;
}

function truncate(text: string, maxLength = 200): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength
    ? `${trimmed.slice(0, maxLength - 1)}…`
    : trimmed;
}

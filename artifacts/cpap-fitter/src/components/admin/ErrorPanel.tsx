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

function describeError(error: unknown): {
  detail: string;
  statusLabel: string | null;
} {
  if (error instanceof ApiError) {
    const status = error.status;
    const statusLabel = status > 0 ? `HTTP ${status}` : null;

    // Validation errors carry { error: "invalid_query", issues: [...] }.
    const data = error.data as
      | {
          error?: string;
          issues?: Array<{ path?: string; message?: string }>;
        }
      | null
      | undefined;

    if (data?.error === "invalid_query" && data.issues && data.issues.length) {
      const first = data.issues[0];
      return {
        statusLabel,
        detail: `Invalid request: ${first.path ?? "field"} — ${first.message ?? "validation failed"}`,
      };
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

  return {
    statusLabel: null,
    detail: "Network error. Check your connection and retry.",
  };
}

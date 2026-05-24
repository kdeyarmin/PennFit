// BulkActionBar — sticky-top bar that appears whenever there's an
// active selection or recent bulk-action feedback.
//
// Generalised from src/pages/admin/patients.tsx (the first page to
// implement bulk actions). The bar's job is purely presentational:
// show selected-count + action buttons, render feedback after the
// most recent action, and provide Clear / Dismiss controls.
//
// What this component does NOT own:
//   - Selection state itself (use hooks/use-bulk-selection.ts).
//   - The actual mutation call (callers pass an onClick per action).
//   - Confirmation dialogs (callers wrap actions with their own
//     window.confirm or modal before invoking the mutation).
//
// Visibility rule: the bar renders nothing when there's no selection
// AND no feedback. It pops in when either becomes truthy and stays
// pinned to the top of its scroll container.

import type { ReactNode } from "react";

import { Button } from "@/components/admin/Button";

export interface BulkAction {
  /** Button label. Conventionally embeds the selection count: "Pause 5". */
  label: ReactNode;
  /** Invoked on click. */
  onClick: () => void;
  /** Visual intent — defaults to "secondary". */
  intent?: "primary" | "secondary" | "ghost";
  /** Show a spinner inside the button. */
  isPending?: boolean;
  /** Disable the button. When any action is pending, all should be disabled. */
  disabled?: boolean;
  /** Stable react key (e.g., "pause", "resume"). Falls back to label string. */
  key?: string;
}

export interface BulkActionBarProps {
  /** Number of currently-selected items. The bar uses this for the count label. */
  selectedCount: number;
  /** Actions to surface on the right side of the bar. */
  actions: BulkAction[];
  /** Clear the entire selection. */
  onClear: () => void;
  /**
   * Optional feedback rendered after the most recent action. The bar
   * stays visible (even with 0 selected) while feedback is non-null
   * so the admin can read the result.
   */
  feedback?: { kind: "success" | "error"; text: string } | null;
  /** Dismiss the feedback (typically clears `feedback` in parent state). */
  onDismissFeedback?: () => void;
  /** Region label for screen readers. Default "Bulk actions". */
  ariaLabel?: string;
}

export function BulkActionBar({
  selectedCount,
  actions,
  onClear,
  feedback,
  onDismissFeedback,
  ariaLabel = "Bulk actions",
}: BulkActionBarProps) {
  // Render nothing when there's no selection AND no feedback — keeps
  // the bar from occupying vertical space when not in use.
  if (selectedCount === 0 && !feedback) return null;

  const isError = feedback?.kind === "error";

  return (
    <div
      className="rounded-md border px-4 py-3 flex items-center justify-between gap-4 sticky top-0 z-10"
      style={{
        borderColor: isError ? "#fca5a5" : "#c9a24a",
        backgroundColor: isError ? "#fef2f2" : "#fffaf0",
      }}
      role="region"
      aria-label={ariaLabel}
    >
      <div className="flex items-center gap-3">
        <span
          className="font-semibold"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          {selectedCount > 0
            ? `${selectedCount} selected on this page`
            : "Bulk action result"}
        </span>
        {feedback && (
          <span
            className="text-sm"
            style={{ color: isError ? "#991b1b" : "#374151" }}
          >
            {feedback.text}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {selectedCount > 0 &&
          actions.map((a, i) => (
            <Button
              key={a.key ?? String(a.label) + i}
              size="sm"
              intent={a.intent ?? "secondary"}
              onClick={a.onClick}
              isLoading={a.isPending}
              disabled={a.disabled || a.isPending}
            >
              {a.label}
            </Button>
          ))}
        {selectedCount > 0 && (
          <Button
            size="sm"
            intent="ghost"
            onClick={onClear}
            disabled={actions.some((a) => a.isPending)}
          >
            Clear selection
          </Button>
        )}
        {selectedCount === 0 && feedback && onDismissFeedback && (
          <Button size="sm" intent="ghost" onClick={onDismissFeedback}>
            Dismiss
          </Button>
        )}
      </div>
    </div>
  );
}

import type { ReactNode } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// Shared admin modal — a thin, accessible wrapper over the Radix dialog.
//
// Why this exists: the admin console grew ~20 hand-rolled `fixed inset-0`
// modals, most of which had no Escape-to-close and no focus trap (you
// could Tab out of the dialog into the page behind it). Radix gives all
// of that for free — Escape, focus trap, scroll lock, `aria-modal`, and
// initial-focus management.
//
// The one subtlety (CLAUDE.md "admin theme stays scoped"): Radix renders
// the dialog in a PORTAL on document.body, OUTSIDE the `.admin-root`
// wrapper, so the admin design tokens (--ink-1, --surface-1, the
// re-pointed --background/--foreground) wouldn't resolve and the dialog
// would render with storefront/undefined colors. We re-apply
// `className="admin-root"` to the portaled content so the tokens resolve
// inside it.
//
// Usage mirrors the hand-rolled `ModalShell` it replaces: render it
// conditionally (mounted = open) and pass `onClose`. `onClose` fires on
// Escape, overlay click, and the built-in close button.
export function AdminModal({
  title,
  description,
  onClose,
  children,
  className,
}: {
  /** Required accessible dialog title (announced to screen readers). */
  title: ReactNode;
  /** Optional sub-title / context line under the title. */
  description?: ReactNode;
  /** Called on Escape, overlay click, or the close button. */
  onClose: () => void;
  children: ReactNode;
  /** Extra classes for the content panel (e.g. a wider `max-w-3xl`). */
  className?: string;
}) {
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        // `admin-root` re-scopes the admin theme tokens inside the portal
        // (see header note). The width/scroll defaults match the
        // hand-rolled shells; callers widen via `className`.
        className={cn(
          "admin-root max-h-[92vh] w-full max-w-2xl overflow-y-auto",
          className,
        )}
      >
        <DialogHeader>
          <DialogTitle style={{ color: "hsl(var(--ink-1))" }}>
            {title}
          </DialogTitle>
          {description ? (
            <DialogDescription style={{ color: "hsl(var(--ink-3))" }}>
              {description}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

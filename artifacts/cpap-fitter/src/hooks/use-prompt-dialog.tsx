// usePromptDialog — accessible `await prompt({…})` replacement for the
// native `window.prompt()` modal.
//
// Sibling of useConfirmDialog (see that file for the rationale): the
// native dialog blocks the main thread, can't be styled, is poorly
// supported by screen readers, ignores the admin-theme `.admin-root`
// scope, and is silently blocked entirely by some browsers. This hook
// is for the prompt case — when the action needs a short free-text
// reason / note (a dismiss reason, a resolution note) rather than a
// yes/no.
//
// API mirrors useConfirmDialog: `const [prompt, PromptDialogEl] =
// usePromptDialog();`. `prompt(...)` resolves to the entered string on
// submit, or `null` when the user cancels / dismisses (Escape, overlay
// click, close button) — matching `window.prompt()` semantics (null ==
// cancel, "" == submitted-empty). Render `{PromptDialogEl}` somewhere in
// the caller's tree.
//
//   const [prompt, PromptDialogEl] = usePromptDialog();
//   async function handleClose() {
//     const note = await prompt({
//       title: "Close plan",
//       description: "A resolution note is required.",
//       required: true,
//     });
//     if (note === null) return; // cancelled
//     await mutateAsync({ note });
//   }
//   return (<>… {PromptDialogEl}</>);

import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export interface PromptDialogOptions {
  /** Required short title — what the text is for. */
  title: string;
  /** Optional explanatory body. Plain string or React node. */
  description?: React.ReactNode;
  /** Placeholder shown in the empty textarea. */
  placeholder?: string;
  /** Submit-button label. Defaults to "Submit". */
  submitLabel?: string;
  /** Cancel-button label. Defaults to "Cancel". */
  cancelLabel?: string;
  /**
   * Require non-empty (trimmed) text before the submit button enables.
   * Default false (an empty submit is allowed — e.g. an optional reason).
   */
  required?: boolean;
  /** Prefill the textarea. */
  defaultValue?: string;
}

export type PromptFn = (opts: PromptDialogOptions) => Promise<string | null>;

interface InternalState {
  open: boolean;
  options: PromptDialogOptions | null;
}

const INITIAL_STATE: InternalState = { open: false, options: null };

/**
 * Provide a `prompt` function and a memoized dialog element for
 * collecting a short free-text response.
 *
 * @returns A tuple: a `PromptFn` that opens the dialog and resolves to
 * the entered string on submit or `null` on cancel/dismiss, and the
 * dialog element to render in the caller's tree.
 */
export function usePromptDialog(): [PromptFn, React.ReactNode] {
  const [state, setState] = React.useState<InternalState>(INITIAL_STATE);
  const [value, setValue] = React.useState("");

  // Admin-theme scoping — same approach as useConfirmDialog. Radix
  // portals the content to document.body, OUTSIDE `.admin-root`, so a
  // hidden sentinel rendered in the caller's tree detects whether we're
  // inside the admin scope and re-applies `admin-root` to the portal.
  const [inAdminScope, setInAdminScope] = React.useState(false);
  const sentinelRef = React.useCallback((node: HTMLSpanElement | null) => {
    if (!node) return;
    const scoped = node.closest(".admin-root") !== null;
    setInAdminScope((prev) => (prev === scoped ? prev : scoped));
  }, []);

  const resolverRef = React.useRef<((v: string | null) => void) | null>(null);

  const prompt = React.useCallback<PromptFn>(
    (options) =>
      new Promise<string | null>((resolve) => {
        // Settle any still-pending prior dialog as a cancel so its
        // awaiting caller doesn't hang.
        if (resolverRef.current) {
          resolverRef.current(null);
        }
        resolverRef.current = resolve;
        setValue(options.defaultValue ?? "");
        setState({ open: true, options });
      }),
    [],
  );

  const settle = React.useCallback((result: string | null) => {
    const r = resolverRef.current;
    resolverRef.current = null;
    setState(INITIAL_STATE);
    if (r) r(result);
  }, []);

  const dialogEl = React.useMemo(() => {
    const opts = state.options;
    const trimmed = value.trim();
    const canSubmit = !opts?.required || trimmed.length > 0;
    return (
      <Dialog
        open={state.open}
        onOpenChange={(open) => {
          // Escape / overlay click / close button → cancel (null),
          // matching window.prompt() semantics.
          if (!open) settle(null);
        }}
      >
        {/* Scope sentinel — rendered inline (NOT portalled) so
            closest() sees the real ancestor chain. */}
        <span ref={sentinelRef} hidden aria-hidden="true" />
        <DialogContent className={inAdminScope ? "admin-root" : undefined}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit) settle(value);
            }}
          >
            <DialogHeader>
              <DialogTitle style={{ color: "hsl(var(--ink-1))" }}>
                {opts?.title ?? ""}
              </DialogTitle>
              {opts?.description ? (
                <DialogDescription asChild>
                  <div style={{ color: "hsl(var(--ink-3))" }}>
                    {opts.description}
                  </div>
                </DialogDescription>
              ) : null}
            </DialogHeader>
            <Textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={opts?.placeholder}
              rows={4}
              className="mt-3"
            />
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => settle(null)}
              >
                {opts?.cancelLabel ?? "Cancel"}
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {opts?.submitLabel ?? "Submit"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );
  }, [state.open, state.options, value, settle, inAdminScope, sentinelRef]);

  return [prompt, dialogEl];
}

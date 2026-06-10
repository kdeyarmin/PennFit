// useConfirmDialog — accessible `await confirm({…})` replacement for
// the native `window.confirm()` modal.
//
// Why this exists:
//   `window.confirm()` blocks the main thread, can't be styled, is
//   inaccessible by default on several screen readers, and ignores
//   the admin-theme scope (the surrounding `.admin-root` brand
//   tokens). Worse, it can't carry rich content (a "Delete X" prompt
//   that lists the affected items, a destructive-variant button).
//
// Why a hook (not a top-level provider):
//   A `<ConfirmDialogProvider>` at app root would couple every admin
//   route to a single dialog instance and force a memo on every
//   render across surfaces that don't even use confirms. Each page
//   that needs confirmations is small; per-page state + a single
//   `<AlertDialog>` rendered inline keeps the dialog physically
//   close to the action that triggers it and easy to reason about
//   in tests.
//
// API ergonomics:
//   The hook returns `[confirm, ConfirmDialogEl]`. `confirm(...)`
//   resolves to `boolean` so existing `if (!window.confirm(...))
//   return;` sites become a near-drop-in:
//
//     const [confirm, ConfirmDialogEl] = useConfirmDialog();
//     async function handleDelete() {
//       if (!(await confirm({
//         title: "Delete rule?",
//         description: `Delete "${name}"? This cannot be undone.`,
//         confirmLabel: "Delete",
//         destructive: true,
//       }))) return;
//       await mutateAsync();
//     }
//     return (<>… {ConfirmDialogEl}</>);
//
//   The resolver pattern (the hook holds a promise resolver between
//   open and close) means `await confirm(...)` returns when the user
//   acts, without manual state choreography in the caller.

import * as React from "react";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";

export interface ConfirmDialogOptions {
  /** Required short title — the question the user is answering. */
  title: string;
  /** Optional explanatory body. Plain string or React node. */
  description?: React.ReactNode;
  /** Confirm-button label. Defaults to "Continue". */
  confirmLabel?: string;
  /** Cancel-button label. Defaults to "Cancel". */
  cancelLabel?: string;
  /**
   * Apply destructive-variant styling to the confirm button. Default
   * false (neutral primary). Set true for irreversible actions:
   * delete, remove, refund.
   */
  destructive?: boolean;
}

interface InternalState {
  open: boolean;
  options: ConfirmDialogOptions | null;
}

const INITIAL_STATE: InternalState = {
  open: false,
  options: null,
};

export type ConfirmFn = (opts: ConfirmDialogOptions) => Promise<boolean>;

/**
 * Provide a confirm function and a memoized dialog element for prompting the user.
 *
 * The returned `confirm` function opens an accessible, styleable confirmation dialog using
 * the supplied options; the dialog resolves the confirmation result when the user confirms,
 * cancels, or dismisses the dialog. The dialog element is memoized to avoid identity churn
 * when rendered by callers.
 *
 * @returns A tuple where the first element is a `ConfirmFn` that opens the dialog and resolves to `true` when the user confirms and `false` when the user cancels or dismisses; the second element is a memoized `React.ReactNode` containing the dialog element to render.
 */
export function useConfirmDialog(): [ConfirmFn, React.ReactNode] {
  const [state, setState] = React.useState<InternalState>(INITIAL_STATE);

  // Admin-theme scoping. Radix portals the dialog content to
  // document.body — OUTSIDE any `.admin-root` wrapper — so on admin
  // pages the content's `bg-background` / destructive-button tokens
  // would resolve to the storefront palette (the hard rule every other
  // admin portal handles by re-applying `admin-root` on its content;
  // see AdminModal). The hook is shared with storefront pages, so we
  // can't hardcode the class: a hidden sentinel rendered where the
  // caller mounts the dialog element detects whether we're inside
  // `.admin-root` and re-scopes the portal content only then.
  const [inAdminScope, setInAdminScope] = React.useState(false);
  const sentinelRef = React.useCallback((node: HTMLSpanElement | null) => {
    if (!node) return;
    const scoped = node.closest(".admin-root") !== null;
    setInAdminScope((prev) => (prev === scoped ? prev : scoped));
  }, []);

  // Keep a ref to the resolver so the action handlers below can settle
  // it without re-binding on every render (which would otherwise
  // re-create the Action/Cancel onClick props every time and defeat
  // any downstream memoization).
  const resolverRef = React.useRef<((v: boolean) => void) | null>(null);

  const confirm = React.useCallback<ConfirmFn>(
    (options) =>
      new Promise<boolean>((resolve) => {
        // If a prior dialog is somehow still pending (e.g. user
        // clicks two buttons in quick succession), resolve it as
        // cancel before opening the new one. Without this the prior
        // caller's await would hang forever.
        if (resolverRef.current) {
          resolverRef.current(false);
        }
        resolverRef.current = resolve;
        setState({ open: true, options });
      }),
    [],
  );

  // Single settle path used by both Confirm and Cancel — and by the
  // dismiss-on-Escape / overlay-click path via onOpenChange. Always
  // clears the resolver so a re-open starts fresh.
  const settle = React.useCallback((value: boolean) => {
    const r = resolverRef.current;
    resolverRef.current = null;
    setState(INITIAL_STATE);
    if (r) r(value);
  }, []);

  // Memoise the dialog element so callers can render `{ConfirmDialogEl}`
  // without worrying about identity churn.
  const dialogEl = React.useMemo(() => {
    const opts = state.options;
    return (
      <AlertDialog
        open={state.open}
        onOpenChange={(open) => {
          // Radix fires this on Escape / overlay click. Treat dismiss
          // as cancel (matches window.confirm() semantics — cancel
          // returns false, confirm returns true).
          if (!open) settle(false);
        }}
      >
        {/* Scope sentinel — see the admin-theme note above. Rendered
            in the caller's tree (NOT portalled) so closest() sees the
            real ancestor chain. */}
        <span ref={sentinelRef} hidden aria-hidden="true" />
        <AlertDialogContent className={inAdminScope ? "admin-root" : undefined}>
          <AlertDialogHeader>
            <AlertDialogTitle>{opts?.title ?? ""}</AlertDialogTitle>
            {opts?.description ? (
              <AlertDialogDescription asChild>
                {/* `asChild` lets callers pass a React node (a list,
                    a paragraph with a <strong>) instead of being
                    locked to a single string. */}
                <div>{opts.description}</div>
              </AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settle(false)}>
              {opts?.cancelLabel ?? "Cancel"}
            </AlertDialogCancel>
            <AlertDialogPrimitive.Action
              className={buttonVariants({
                variant: opts?.destructive ? "destructive" : "default",
              })}
              onClick={() => settle(true)}
            >
              {opts?.confirmLabel ?? "Continue"}
            </AlertDialogPrimitive.Action>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }, [state.open, state.options, settle, inAdminScope, sentinelRef]);

  return [confirm, dialogEl];
}

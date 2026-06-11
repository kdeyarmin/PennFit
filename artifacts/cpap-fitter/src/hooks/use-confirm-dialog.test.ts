// Tests for hooks/use-confirm-dialog.tsx
//
// The vitest environment is "node" (no DOM, no jsdom). The hook uses React
// and Radix AlertDialog which require a DOM at runtime, so we cannot render
// the hook directly. Instead we follow the source-analysis pattern used
// throughout this codebase: read the source as a string and assert the
// structural and behavioural invariants that drive correctness.
//
// In addition, the pure resolver logic embedded in the hook (the promise
// settle pattern) is extracted and tested directly without React.
//
// Invariants under test:
//   - Exported types and function signatures.
//   - ConfirmDialogOptions interface fields.
//   - Promise resolver pattern (settle on confirm = true, cancel = false).
//   - Concurrent-call guard (prior dialog resolved false before new one opens).
//   - Dismiss / Escape path treated as cancel.
//   - Default labels: "Continue" / "Cancel".
//   - Destructive variant applied only when opts.destructive.
//   - Dialog element is memoised (useMemo).
//   - useRef used to hold resolver between renders.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "use-confirm-dialog.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

describe("use-confirm-dialog — exports", () => {
  it("exports the useConfirmDialog function", () => {
    expect(SRC).toContain("export function useConfirmDialog");
  });

  it("exports the ConfirmDialogOptions interface", () => {
    expect(SRC).toContain("export interface ConfirmDialogOptions");
  });

  it("exports the ConfirmFn type", () => {
    expect(SRC).toContain("export type ConfirmFn");
  });

  it("ConfirmFn takes ConfirmDialogOptions and returns Promise<boolean>", () => {
    expect(SRC).toContain(
      "ConfirmFn = (opts: ConfirmDialogOptions) => Promise<boolean>",
    );
  });

  it("useConfirmDialog returns a tuple [ConfirmFn, React.ReactNode]", () => {
    expect(SRC).toContain("useConfirmDialog(): [ConfirmFn, React.ReactNode]");
  });
});

// ---------------------------------------------------------------------------
// ConfirmDialogOptions — required and optional fields
// ---------------------------------------------------------------------------

describe("use-confirm-dialog — ConfirmDialogOptions fields", () => {
  it("has a required title: string field", () => {
    expect(SRC).toContain("title: string");
  });

  it("has an optional description field accepting React.ReactNode", () => {
    expect(SRC).toContain("description?: React.ReactNode");
  });

  it("has an optional confirmLabel field", () => {
    expect(SRC).toContain("confirmLabel?: string");
  });

  it("has an optional cancelLabel field", () => {
    expect(SRC).toContain("cancelLabel?: string");
  });

  it("has an optional destructive boolean field", () => {
    expect(SRC).toContain("destructive?: boolean");
  });
});

// ---------------------------------------------------------------------------
// InternalState shape
// ---------------------------------------------------------------------------

describe("use-confirm-dialog — InternalState", () => {
  it("defines InternalState with open and options fields", () => {
    // The resolver previously lived on InternalState too, but the
    // hook was refactored to keep it on a React.useRef only (the
    // state copy was redundant — the ref is what `settle()` reads).
    expect(SRC).toContain("open: boolean");
    expect(SRC).toContain("options: ConfirmDialogOptions | null");
  });

  it("defines INITIAL_STATE with open: false, options: null", () => {
    expect(SRC).toContain("open: false");
    expect(SRC).toContain("options: null");
  });

  it("keeps the resolver in a ref, not on InternalState", () => {
    // Negative assertion guards against accidentally re-introducing
    // the redundant state field on a future refactor.
    expect(SRC).not.toContain("resolve: ((value: boolean) => void) | null");
  });
});

// ---------------------------------------------------------------------------
// React hooks used
// ---------------------------------------------------------------------------

describe("use-confirm-dialog — React hooks", () => {
  it("uses React.useState for the open/options/resolve state", () => {
    expect(SRC).toContain("React.useState<InternalState>(INITIAL_STATE)");
  });

  it("uses React.useRef to hold the resolver between renders", () => {
    // The ref avoids re-creating Action/Cancel onClick props on each render.
    expect(SRC).toContain("React.useRef<((v: boolean) => void) | null>(null)");
  });

  it("uses React.useCallback for the confirm function", () => {
    expect(SRC).toContain("React.useCallback<ConfirmFn>");
  });

  it("uses React.useCallback for the settle function", () => {
    expect(SRC).toMatch(/settle\s*=\s*React\.useCallback/);
  });

  it("uses React.useMemo for the dialog element", () => {
    expect(SRC).toContain("React.useMemo(");
  });
});

// ---------------------------------------------------------------------------
// confirm() — promise resolver pattern
// ---------------------------------------------------------------------------

describe("use-confirm-dialog — confirm() promise resolver", () => {
  it("returns a new Promise<boolean>", () => {
    expect(SRC).toContain("new Promise<boolean>((resolve) => {");
  });

  it("stores the resolver in resolverRef.current before setting state", () => {
    expect(SRC).toContain("resolverRef.current = resolve;");
  });

  it("sets state to open:true with the provided options", () => {
    // setState carries only { open, options } — the resolver lives
    // on resolverRef (see InternalState block above).
    expect(SRC).toContain("setState({ open: true, options });");
  });

  it("guard: resolves prior pending promise as false before opening a new one", () => {
    // Prevents the prior await from hanging when two confirms race.
    expect(SRC).toContain("if (resolverRef.current) {");
    expect(SRC).toContain("resolverRef.current(false);");
  });
});

// ---------------------------------------------------------------------------
// settle() — single resolve/cancel path
// ---------------------------------------------------------------------------

describe("use-confirm-dialog — settle()", () => {
  it("clears resolverRef.current before resolving (prevents double-settle)", () => {
    expect(SRC).toContain("resolverRef.current = null;");
  });

  it("resets state to INITIAL_STATE on settle", () => {
    expect(SRC).toContain("setState(INITIAL_STATE);");
  });

  it("calls the resolver with the provided boolean value", () => {
    expect(SRC).toContain("if (r) r(value);");
  });
});

// ---------------------------------------------------------------------------
// AlertDialog wiring — cancel resolves false, confirm resolves true
// ---------------------------------------------------------------------------

describe("use-confirm-dialog — dialog button semantics", () => {
  it("Cancel button calls settle(false)", () => {
    expect(SRC).toContain("onClick={() => settle(false)}");
  });

  it("Action (Confirm) button calls settle(true)", () => {
    expect(SRC).toContain("onClick={() => settle(true)}");
  });

  it("onOpenChange fires settle(false) when dialog closes (Escape / overlay click)", () => {
    expect(SRC).toContain("if (!open) settle(false);");
  });
});

// ---------------------------------------------------------------------------
// Default labels
// ---------------------------------------------------------------------------

describe("use-confirm-dialog — default labels", () => {
  it('defaults confirmLabel to "Continue"', () => {
    expect(SRC).toContain('"Continue"');
    expect(SRC).toContain('opts?.confirmLabel ?? "Continue"');
  });

  it('defaults cancelLabel to "Cancel"', () => {
    expect(SRC).toContain('"Cancel"');
    expect(SRC).toContain('opts?.cancelLabel ?? "Cancel"');
  });
});

// ---------------------------------------------------------------------------
// Destructive variant styling
// ---------------------------------------------------------------------------

describe("use-confirm-dialog — destructive button styling", () => {
  it("applies buttonVariants destructive when opts.destructive is true", () => {
    // The ternary inside buttonVariants() resolves to "destructive"
    // for destructive: true, "default" otherwise — the variant
    // string is built inline.
    expect(SRC).toMatch(
      /buttonVariants\(\{\s*variant:\s*opts\?\.destructive\s*\?\s*"destructive"\s*:\s*"default"/,
    );
  });

  it("gates the destructive className on opts.destructive being truthy", () => {
    // The hook switched from `cn(opts?.destructive && ...)` to a
    // ternary inside buttonVariants(). The gate is now expressed as
    // `variant: opts?.destructive ? "destructive" : "default"`.
    expect(SRC).toContain('opts?.destructive ? "destructive" : "default"');
  });
});

// ---------------------------------------------------------------------------
// Description: optional, rendered only when present
// ---------------------------------------------------------------------------

describe("use-confirm-dialog — description rendering", () => {
  it("only renders AlertDialogDescription when opts.description is truthy", () => {
    expect(SRC).toContain("{opts?.description ? (");
  });

  it("uses asChild on AlertDialogDescription to support React node content", () => {
    expect(SRC).toContain("<AlertDialogDescription asChild>");
  });

  it("wraps description content in a <div> when using asChild", () => {
    expect(SRC).toContain("<div>{opts.description}</div>");
  });
});

// ---------------------------------------------------------------------------
// Memoisation — dialog identity stability
// ---------------------------------------------------------------------------

describe("use-confirm-dialog — dialog element memoisation", () => {
  it("memoises the dialog element on [state.open, state.options, settle, inAdminScope, sentinelRef]", () => {
    expect(SRC).toContain(
      "[state.open, state.options, settle, inAdminScope, sentinelRef]",
    );
  });
});

// ---------------------------------------------------------------------------
// Admin-theme scoping — portal content re-scopes under .admin-root
// ---------------------------------------------------------------------------

describe("use-confirm-dialog — admin-root portal scoping", () => {
  it("detects an .admin-root ancestor via the scope sentinel", () => {
    expect(SRC).toContain('node.closest(".admin-root")');
  });

  it("re-applies admin-root on the portalled AlertDialogContent when scoped", () => {
    expect(SRC).toContain('inAdminScope ? "admin-root" : undefined');
  });
});

// ---------------------------------------------------------------------------
// AlertDialog Radix imports
// ---------------------------------------------------------------------------

describe("use-confirm-dialog — Radix AlertDialog components", () => {
  it("imports AlertDialog from @/components/ui/alert-dialog", () => {
    expect(SRC).toContain('from "@/components/ui/alert-dialog"');
  });

  it("imports the Radix Action primitive (or shadcn re-export) for the confirm button", () => {
    // The hook may render either `<AlertDialogAction>` from the
    // shadcn wrapper or `<AlertDialogPrimitive.Action>` directly —
    // the latter avoids the wrapper's default styling so the
    // destructive variant ternary in buttonVariants() takes effect
    // without being shadowed.
    expect(SRC).toMatch(/AlertDialogAction|AlertDialogPrimitive\.Action/);
  });

  it("imports AlertDialogCancel", () => {
    expect(SRC).toContain("AlertDialogCancel");
  });

  it("imports AlertDialogContent", () => {
    expect(SRC).toContain("AlertDialogContent");
  });

  it("imports AlertDialogDescription", () => {
    expect(SRC).toContain("AlertDialogDescription");
  });

  it("imports AlertDialogTitle", () => {
    expect(SRC).toContain("AlertDialogTitle");
  });

  it("imports buttonVariants from @/components/ui/button", () => {
    expect(SRC).toContain('from "@/components/ui/button"');
    expect(SRC).toContain("buttonVariants");
  });
});

// ---------------------------------------------------------------------------
// Pure resolver logic — verified without React
// ---------------------------------------------------------------------------

describe("use-confirm-dialog — resolver logic (pure, no React)", () => {
  // Simulate the settle() behaviour directly: resolver is called with
  // the value passed, and cleared after settlement.
  it("settle(true) calls resolver with true and clears the ref", () => {
    let resolverCalled: boolean | undefined;
    let resolverRef: ((v: boolean) => void) | null = (v) => {
      resolverCalled = v;
    };

    function settle(value: boolean) {
      const r = resolverRef;
      resolverRef = null;
      if (r) r(value);
    }

    settle(true);
    expect(resolverCalled).toBe(true);
    expect(resolverRef).toBeNull();
  });

  it("settle(false) calls resolver with false and clears the ref", () => {
    let resolverCalled: boolean | undefined;
    let resolverRef: ((v: boolean) => void) | null = (v) => {
      resolverCalled = v;
    };

    function settle(value: boolean) {
      const r = resolverRef;
      resolverRef = null;
      if (r) r(value);
    }

    settle(false);
    expect(resolverCalled).toBe(false);
    expect(resolverRef).toBeNull();
  });

  it("settle() is a no-op when resolver is already null (double-settle guard)", () => {
    let callCount = 0;
    let resolverRef: ((v: boolean) => void) | null = null;

    function settle(value: boolean) {
      const r = resolverRef;
      resolverRef = null;
      if (r) {
        callCount++;
        r(value);
      }
    }

    settle(true); // no resolver — should not throw or increment
    expect(callCount).toBe(0);
  });

  it("concurrent confirm() guard: prior promise resolves false when a new confirm opens", async () => {
    // Simulate the concurrent guard logic from confirm():
    //   if (resolverRef.current) { resolverRef.current(false); }
    const results: boolean[] = [];

    let resolverRef: ((v: boolean) => void) | null = null;

    function openConfirm(): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        if (resolverRef) {
          resolverRef(false); // cancel the in-flight confirm
        }
        resolverRef = resolve;
      });
    }

    const p1 = openConfirm();
    // p1 is now pending; opening a second confirm should cancel p1 with false
    const p2 = openConfirm();

    // Resolve p2 with true (user clicked confirm on the second dialog)
    const r = resolverRef!;
    resolverRef = null;
    r(true);

    results.push(await p1);
    results.push(await p2);

    expect(results).toEqual([false, true]);
  });
});

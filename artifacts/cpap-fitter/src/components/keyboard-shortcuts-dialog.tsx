// KeyboardShortcutsDialog — press "?" anywhere on the storefront to
// surface a small modal listing the discoverable shortcuts. Mounted
// globally (in <Layout>) so it works on every customer page.
//
// Why a global affordance: the per-page hints (the visible "/" kbd
// chip in the FAQ + Shop search inputs) only advertise the search
// shortcut, and only on the pages where it matters. The "?" → help
// dialog is the standard discoverability pattern shoppers already
// know from Slack, GitHub, Notion, Linear, et al. — it gives the
// next user who wonders "are there other shortcuts?" a one-keystroke
// answer.
//
// We open on bare "?" (Shift + /) but ignore when the user is typing
// in another input / textarea / contenteditable — same skip rules
// the search shortcut uses, since "?" is a real character in
// passwords, prose, etc.

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

interface Shortcut {
  keys: string[];
  description: string;
  scope: string;
}

const SHORTCUTS: Shortcut[] = [
  {
    keys: ["/"],
    description: "Focus the search input",
    scope: "Shop, FAQ",
  },
  {
    keys: ["Esc"],
    description: "Clear the search input and exit results",
    scope: "Shop, FAQ (while focused)",
  },
  {
    keys: ["?"],
    description: "Open this keyboard shortcut help",
    scope: "Anywhere",
  },
];

export function KeyboardShortcutsDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Bare "?" — Shift+/ on US layouts. Ignore if the user is
      // typing somewhere editable or if a modifier other than Shift
      // is held (Cmd+? / Ctrl+? are reserved for browser/OS).
      if (e.key !== "?") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      setOpen((v) => !v);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="sm:max-w-md"
        data-testid="keyboard-shortcuts-dialog"
      >
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription>
          Quick keyboard moves available across the PennPaps storefront.
        </DialogDescription>
        <ul className="mt-2 space-y-2">
          {SHORTCUTS.map((s) => (
            <li
              key={s.description}
              className="flex items-start gap-3 text-sm"
              data-testid={`kbd-row-${s.keys.join("-")}`}
            >
              <span className="flex gap-1 shrink-0 mt-0.5">
                {s.keys.map((k) => (
                  <kbd
                    key={k}
                    className="inline-flex items-center justify-center min-w-7 h-6 px-1.5 rounded border border-border/60 bg-secondary/40 text-[11px] font-mono font-semibold text-foreground"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
              <span className="flex-1">
                <span className="font-medium text-foreground">
                  {s.description}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {s.scope}
                </span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] text-muted-foreground">
          Press{" "}
          <kbd className="inline-flex items-center justify-center min-w-5 h-4 px-1 rounded border border-border/60 bg-secondary/40 text-[10px] font-mono font-semibold">
            Esc
          </kbd>{" "}
          to close this dialog.
        </p>
      </DialogContent>
    </Dialog>
  );
}

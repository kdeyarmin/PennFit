// One-click copy for the IDs / SKUs / reference codes that staff paste
// dozens of times a shift (into case links, coaching plans, fax triage,
// other tools). Renders the value in the usual monospace style with a
// small copy affordance; clicking copies to the clipboard and briefly
// shows a check. Falls back gracefully when the Clipboard API is
// unavailable (insecure context / older browser) by surfacing the value
// in a toast so it can still be selected.

import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface CopyableIdProps {
  /** The full value to copy. */
  value: string;
  /**
   * Optional display text (e.g. a truncated `id.slice(0, 8)`); the full
   * `value` is always what gets copied. Defaults to `value`.
   */
  label?: string;
  /** Accessible label for the copy button. Defaults to "Copy <value>". */
  title?: string;
  className?: string;
}

export function CopyableId({
  value,
  label,
  title,
  className,
}: CopyableIdProps) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: "Couldn't copy automatically", description: value });
    }
  };

  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span className="font-mono">{label ?? value}</span>
      <button
        type="button"
        onClick={copy}
        title={title ?? `Copy ${value}`}
        aria-label={title ?? `Copy ${value}`}
        className="inline-flex shrink-0 items-center rounded p-0.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden />
        )}
      </button>
    </span>
  );
}

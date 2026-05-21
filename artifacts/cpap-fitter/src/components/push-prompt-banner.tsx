// One-time dismissible banner that prompts the signed-in patient
// to enable web push notifications for shipment + delivery updates.
//
// Why this exists
// ---------------
// The push subscription UI is buried inside the CommPrefsSection on
// /account. Patients who'd happily turn it on never see the toggle
// because they don't go hunting through "Communication preferences"
// for an opt-in they didn't know existed. A friendly banner near
// the top of /account, surfaced only when:
//
//   * The browser supports push (state="off"), AND
//   * The server is configured (state !== "not-configured"), AND
//   * The patient hasn't dismissed this banner before.
//
// We use localStorage rather than a server-side dismissal flag —
// the dismissal is per-device, not per-account, and we want the
// banner back if the patient signs in on a new browser.

import { useEffect, useState } from "react";
import { Bell, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { usePushSubscription } from "@/hooks/use-push-subscription";

const DISMISS_KEY = "pf_push_prompt_dismissed_v1";

export function PushPromptBanner() {
  const { state, busy, enable, error } = usePushSubscription();
  const [dismissed, setDismissed] = useState(true);

  // Initialize from localStorage on mount. Default to "dismissed"
  // (true) so we don't flash the banner before we know whether the
  // patient already hid it.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(DISMISS_KEY);
      setDismissed(stored === "1");
    } catch {
      // localStorage access can throw in private-mode browsers; default
      // to dismissed in that case so we don't pester.
      setDismissed(true);
    }
  }, []);

  function handleDismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore — banner stays hidden for this session at least */
    }
    setDismissed(true);
  }

  async function handleEnable() {
    await enable();
    // If the patient went through the permission dialog and approved,
    // the hook's state flips to "on" and this component unmounts on
    // the next render. Either way, stop showing the banner.
    handleDismiss();
  }

  if (dismissed) return null;
  if (state !== "off") return null;

  return (
    <section
      className="glass-card rounded-2xl p-4 sm:p-5 flex items-start gap-4"
      data-testid="account-push-prompt"
    >
      <div className="shrink-0 h-10 w-10 rounded-xl icon-halo-navy flex items-center justify-center">
        <Bell className="h-5 w-5" />
      </div>
      <div className="flex-1 min-w-0 space-y-1.5">
        <p className="font-semibold tracking-tight">
          Get a ping when your supplies ship?
        </p>
        <p className="text-sm text-muted-foreground leading-relaxed">
          We&apos;ll send a single notification when your order leaves
          our warehouse and another when it arrives. No marketing — just
          shipment status.
        </p>
        {error && (
          <p className="text-xs text-destructive" data-testid="push-prompt-error" role="alert">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            disabled={busy}
            onClick={handleEnable}
            data-testid="push-prompt-enable"
            className="rounded-full"
          >
            {busy ? "Enabling…" : "Enable notifications"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleDismiss}
            data-testid="push-prompt-dismiss"
            className="rounded-full"
          >
            Not now
          </Button>
        </div>
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss"
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
    </section>
  );
}

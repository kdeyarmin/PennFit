import React, { useCallback, useEffect, useState } from "react";
import { Download, X } from "lucide-react";

/**
 * Lightweight, dismissable PWA install prompt.
 *
 * The browser fires `beforeinstallprompt` on Chrome/Edge/Samsung
 * Internet/Brave when the site meets PWA install criteria
 * (manifest + HTTPS + has been engaged with at least once). We
 * capture the event and surface a small footer card; tapping
 * "Install" calls `prompt()` and the browser shows the native
 * install UI.
 *
 * iOS Safari does NOT fire this event — Apple uses a manual
 * "Add to Home Screen" share-sheet flow. We don't try to detect or
 * coach iOS users here; that's a separate banner with a
 * platform-specific gesture explanation, and it tends to feel
 * pushy. Customers on iOS who want the app on their home screen
 * already know how (or will discover the manifest's apple-touch-icon
 * + display:standalone behaviour the first time they add it).
 *
 * Suppression: once the user dismisses (X) we set a localStorage
 * flag and never show again on this device. If they actually
 * install, the `appinstalled` event fires and we also clear the
 * captured prompt so it doesn't reappear if they later uninstall.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const SUPPRESS_KEY = "pennpaps_pwa_install_dismissed";
const SUPPRESS_FOR_DAYS = 60;

function isSuppressed(): boolean {
  try {
    const raw = localStorage.getItem(SUPPRESS_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < SUPPRESS_FOR_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function suppress() {
  try {
    localStorage.setItem(SUPPRESS_KEY, String(Date.now()));
  } catch {
    // localStorage unavailable (private mode, quota exceeded) — silently
    // accept that the prompt may reappear next session. Better than
    // crashing the prompt entirely.
  }
}

export function PwaInstallPrompt() {
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isSuppressed()) return;

    // Hide immediately if the user is already running in standalone
    // mode (i.e. they already installed) — no point showing an
    // install prompt.
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      // iOS Safari standalone PWA flag
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (navigator as any).standalone === true;
    if (standalone) return;

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvt(e as BeforeInstallPromptEvent);
      setVisible(true);
    };
    const onInstalled = () => {
      setEvt(null);
      setVisible(false);
      suppress();
    };

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const onDismiss = useCallback(() => {
    setVisible(false);
    setEvt(null);
    suppress();
  }, []);

  const onInstall = useCallback(async () => {
    if (!evt) return;
    try {
      await evt.prompt();
      await evt.userChoice;
    } catch {
      // The prompt() call throws if invoked twice or out-of-order;
      // suppressing keeps the user from getting stuck on a dead button.
    }
    setVisible(false);
    setEvt(null);
    suppress();
  }, [evt]);

  if (!visible || !evt) return null;

  return (
    <div
      className="fixed bottom-4 inset-x-4 sm:inset-x-auto sm:right-4 sm:bottom-6 z-40 max-w-sm sm:w-[22rem] rounded-2xl border bg-white shadow-lg p-4 print:hidden"
      role="dialog"
      aria-labelledby="pwa-install-title"
      data-testid="pwa-install-prompt"
    >
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 rounded-xl bg-[hsl(var(--penn-gold)/0.18)] flex items-center justify-center shrink-0">
          <Download className="w-5 h-5 text-[hsl(var(--penn-navy))]" />
        </div>
        <div className="flex-1 min-w-0">
          <h3
            id="pwa-install-title"
            className="text-sm font-semibold text-[hsl(var(--penn-navy))]"
          >
            Install PennPaps
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
            One tap to add the app to your home screen. Faster reorders, no
            login each time.
          </p>
          <div className="flex gap-2 mt-3">
            <button
              type="button"
              onClick={onInstall}
              className="rounded-full bg-[hsl(var(--penn-navy))] text-white text-xs font-semibold px-4 py-1.5 hover:bg-[hsl(var(--penn-navy))]/90 transition-colors"
              data-testid="pwa-install-confirm"
            >
              Install
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-full text-xs font-medium px-3 py-1.5 text-muted-foreground hover:text-[hsl(var(--penn-navy))] transition-colors"
              data-testid="pwa-install-not-now"
            >
              Not now
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss install prompt"
          className="text-muted-foreground hover:text-[hsl(var(--penn-navy))] transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

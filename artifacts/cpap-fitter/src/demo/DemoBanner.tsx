// The global demo-mode banner. Rendered above the router on every
// surface (storefront + admin). Two states:
//   * demo ON  → a status bar with an "Exit to live site" toggle.
//   * demo OFF → a dismissible invite to start the interactive demo.
//
// Styling is intentionally self-contained (explicit colors, no theme
// tokens) so it renders identically on the storefront and inside the
// admin console without depending on either token set — and so it
// never trips the admin theme-scoping rule. It sits in normal document
// flow (not sticky/fixed) so it can't overlap the storefront's sticky
// header or the bottom-pinned mobile CTA / contact launcher.

import { useState } from "react";
import { useDemoMode } from "./DemoModeProvider";

const INVITE_DISMISSED_KEY = "pennfit:demo-invite-dismissed:v1";

function readInviteDismissed(): boolean {
  try {
    return window.localStorage.getItem(INVITE_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function DemoBanner() {
  const { isDemo, enterDemo, exitDemo } = useDemoMode();
  const [inviteDismissed, setInviteDismissed] =
    useState<boolean>(readInviteDismissed);

  if (isDemo) {
    return (
      <div
        role="region"
        aria-label="Demo mode"
        className="flex w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-amber-400 px-4 py-2 text-center text-sm font-medium text-amber-950"
      >
        <span aria-hidden="true">🧪</span>
        <span>
          <strong>Demo mode</strong> — you're exploring PennFit with simulated
          data. Nothing here is real and no orders are placed.
        </span>
        <button
          type="button"
          onClick={exitDemo}
          className="rounded-full bg-amber-950 px-3 py-1 text-xs font-semibold text-amber-50 transition-colors hover:bg-amber-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-900 focus-visible:ring-offset-2 focus-visible:ring-offset-amber-400"
        >
          Exit to live site
        </button>
      </div>
    );
  }

  if (inviteDismissed) return null;

  return (
    <div
      role="region"
      aria-label="Try the demo"
      className="flex w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-[#0b2545] px-4 py-2 text-center text-sm font-medium text-white"
    >
      <span aria-hidden="true">👋</span>
      <span>
        New here? Take an interactive tour of the entire site with sample data —
        no sign-up required.
      </span>
      <button
        type="button"
        onClick={enterDemo}
        className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-[#0b2545] transition-colors hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b2545]"
      >
        Start demo
      </button>
      <button
        type="button"
        aria-label="Dismiss demo invitation"
        onClick={() => {
          try {
            window.localStorage.setItem(INVITE_DISMISSED_KEY, "1");
          } catch {
            /* best-effort */
          }
          setInviteDismissed(true);
        }}
        className="rounded-full px-2 py-1 text-xs font-semibold text-white/80 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        ✕
      </button>
    </div>
  );
}

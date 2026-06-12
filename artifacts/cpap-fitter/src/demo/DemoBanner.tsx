// Global demo-mode banner (app-review 2026-06-10, P2-7).
//
// `?demo=1` persistently flips the client into the fake-data sandbox
// (localStorage — it survives every subsequent visit). Admins manage
// that deliberately from /admin/settings, but a CUSTOMER who follows a
// shared demo link gets a storefront full of sample products and fake
// prices with nothing on screen saying so and no way out. This banner
// renders on every surface while demo mode is active: it names the
// mode and offers a one-click exit (which reloads into the live site).
//
// Colors are hardcoded (not theme tokens) on purpose: the banner spans
// both the storefront and the admin console, and the admin theme is
// scoped under `.admin-root` — token-based colors would resolve
// differently (or not at all) depending on which surface is mounted.

import { useDemoMode } from "./DemoModeProvider";

export function DemoBanner() {
  const { isDemo, exitDemo } = useDemoMode();
  if (!isDemo) return null;
  return (
    <div
      role="status"
      data-testid="demo-mode-banner"
      className="flex items-center justify-center gap-3 px-4 py-2 text-sm font-medium"
      style={{
        backgroundColor: "#fef3c7",
        color: "#854d0e",
        borderBottom: "1px solid #fde68a",
      }}
    >
      <span>
        Demo mode — you&rsquo;re viewing sample data, not the live store.
      </span>
      <button
        type="button"
        onClick={exitDemo}
        data-testid="demo-mode-exit"
        className="underline underline-offset-2 font-semibold hover:opacity-80"
        style={{ color: "#854d0e" }}
      >
        Exit demo
      </button>
    </div>
  );
}

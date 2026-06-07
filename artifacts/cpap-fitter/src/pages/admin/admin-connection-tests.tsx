// /admin/connection-tests — dedicated destination for the super-admin
// "send a test" panel.
//
// The same ConnectionTests panel also leads the System Configuration page
// (/admin/system/configuration). This standalone page gives it its own
// nav entry so an operator can jump straight to "test my integrations"
// without scrolling the credential list — the discoverability gap this
// page closes.
//
// Gating mirrors the configuration page: the nav entry is hidden unless
// the caller holds `system.config.manage` (super_admin), and every
// /admin/connection-tests/* API route enforces the same permission, so a
// non-super-admin who reaches this URL sees the panel report auth errors
// rather than a usable control. The outer <div> needs no `admin-root`
// wrapper: the AppShell content slot it renders into already provides one
// (same as the sibling System Configuration page).

import { Plug } from "lucide-react";

import { ConnectionTests } from "@/components/admin/ConnectionTests";

export function AdminConnectionTestsPage() {
  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <header className="space-y-1">
        <h1
          className="text-2xl font-semibold flex items-center gap-2"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          <Plug className="h-6 w-6" /> Connection tests
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          Send a real test through each channel — email, SMS, voice, and chat/AI
          — to confirm the integration credentials are set up correctly. Runs
          against the saved/effective configuration, so a key entered on the
          Configuration page can be verified before the next deploy. Restricted
          to super-admins.
        </p>
      </header>

      <ConnectionTests />
    </div>
  );
}

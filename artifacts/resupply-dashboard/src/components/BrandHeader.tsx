import type { ReactNode } from "react";

// Reusable Penn-branded top bar. Lifted out of App.tsx so AppShell
// can mount the same chrome on every console screen without forcing
// every page to redeclare brand tokens.

export function BrandHeader({ rightSlot }: { rightSlot?: ReactNode }) {
  return (
    <header
      className="flex items-center justify-between px-6 py-4 border-b"
      style={{ backgroundColor: "#0a1f44", borderColor: "#0a1f44" }}
    >
      <div className="flex items-center gap-3">
        <div
          className="h-8 w-8 rounded flex items-center justify-center font-bold"
          style={{ backgroundColor: "#c9a24a", color: "#0a1f44" }}
          aria-hidden="true"
        >
          P
        </div>
        <div className="leading-tight">
          <div className="text-white font-semibold tracking-tight">
            Penn Resupply Console
          </div>
          <div className="text-xs" style={{ color: "#c9a24a" }}>
            Operator workstation
          </div>
        </div>
      </div>
      {rightSlot ? (
        <div className="text-xs text-white/80">{rightSlot}</div>
      ) : null}
    </header>
  );
}

export function BrandFooter() {
  return (
    <footer
      className="text-xs px-6 py-3 border-t text-center"
      style={{
        color: "#6b7280",
        backgroundColor: "#ffffff",
        borderColor: "#e5e7eb",
      }}
    >
      Penn Home Medical Supply · Internal tooling · Not for patient use
    </footer>
  );
}

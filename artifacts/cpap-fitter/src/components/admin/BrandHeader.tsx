import type { ReactNode } from "react";

// PennPaps-branded top chrome. Replaces the old hardcoded-hex band with
// a token-driven `.brand-band` (radial gold glow over the navy gradient)
// and an `.aurora-divider` underneath that threads a hairline of brand
// gold across the band-to-canvas seam — matches the customer-app
// vocabulary so the two SPAs feel like one product.

export function BrandHeader({ rightSlot }: { rightSlot?: ReactNode }) {
  return (
    <>
      <header className="brand-band relative flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <div
            className="h-9 w-9 rounded-md flex items-center justify-center font-bold text-base shadow-sm"
            style={{
              background:
                "linear-gradient(135deg, hsl(var(--penn-gold)) 0%, hsl(var(--penn-gold-deep)) 100%)",
              color: "hsl(var(--penn-navy-deep))",
              boxShadow:
                "0 1px 0 rgba(255,255,255,0.4) inset, 0 4px 10px hsl(var(--penn-navy) / 0.4)",
            }}
            aria-hidden="true"
          >
            P
          </div>
          <div className="leading-tight">
            <div className="text-white font-semibold tracking-tight text-sm">
              PennPaps
            </div>
            <div
              className="text-[10px] uppercase tracking-[0.18em] font-semibold"
              style={{ color: "hsl(var(--penn-gold-soft))" }}
            >
              Admin workstation
            </div>
          </div>
        </div>
        {rightSlot ? (
          <div className="text-xs text-white/85">{rightSlot}</div>
        ) : null}
      </header>
      <div className="aurora-divider" aria-hidden="true" />
    </>
  );
}

export function BrandFooter() {
  return (
    <footer
      className="text-[11px] px-6 py-3 border-t text-center font-medium tracking-wide"
      style={{
        color: "hsl(var(--ink-3))",
        backgroundColor: "hsl(var(--surface-2))",
        borderColor: "hsl(var(--line-1))",
      }}
    >
      PennPaps · Internal tooling · Not for patient use
    </footer>
  );
}

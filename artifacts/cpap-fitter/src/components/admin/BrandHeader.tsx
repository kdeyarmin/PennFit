import { useState, type ReactNode } from "react";

import {
  PLATFORM_ICON_URL,
  PLATFORM_NAME,
  useStorefrontBranding,
} from "@/lib/branding";

// Admin workstation top chrome. The admin console is the CareMetric
// Breathe *platform* product (every tenant's staff signs into the same
// software), so the primary brand is always CareMetric Breathe; the
// host-resolved tenant brand (PennPaps for the Penn Home Medical Supply
// tenant) rides along as a secondary label. Token-driven `.brand-band`
// (radial gold glow over the navy gradient) with an `.aurora-divider`
// underneath — matches the customer-app vocabulary so the two SPAs feel
// like one product.
//
// Tenant-neutral until resolved: `useStorefrontBranding()`'s bundled
// fallback is the Penn tenant's "PennPaps", which is correct on the
// storefront but would mis-label a DIFFERENT tenant's admin console before
// (or if) the host-resolved fetch lands. So the shared admin chrome shows a
// neutral label until `resolved` is true, then the real tenant name.
const NEUTRAL_TENANT_LABEL = "Storefront";

// The brand slot shows the real platform mark, not a monogram. Because it
// is the PLATFORM chrome it always renders the CareMetric icon — never the
// host-resolved tenant's `logoUrl`, which would imply the tenant wrote the
// software. `PLATFORM_ICON_URL` is the wordmark-free square crop; the full
// lockup is illegible at 36px (see the constant's doc comment).
//
// If the asset ever fails to load (stale cache, a bad deploy, an offline
// tab) we fall back to the previous gold "CB" monogram rather than leaving
// a broken-image box in the header.

function BrandMark() {
  const [assetFailed, setAssetFailed] = useState(false);
  if (assetFailed) {
    return (
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
        CB
      </div>
    );
  }
  return (
    <img
      src={PLATFORM_ICON_URL}
      // Decorative: PLATFORM_NAME is set as text immediately beside it, so
      // an alt would just make screen readers say the brand twice.
      alt=""
      aria-hidden="true"
      // Intrinsic dimensions of the square icon (357×357) so the browser
      // reserves the box and the header doesn't shift on first paint.
      width={357}
      height={357}
      className="h-9 w-9 rounded-md object-contain"
      style={{ boxShadow: "0 4px 10px hsl(var(--penn-navy) / 0.4)" }}
      onError={() => setAssetFailed(true)}
      data-testid="admin-brand-mark"
    />
  );
}

export function BrandHeader({ rightSlot }: { rightSlot?: ReactNode }) {
  const { storefrontName, resolved } = useStorefrontBranding();
  const tenantLabel = resolved ? storefrontName : NEUTRAL_TENANT_LABEL;
  return (
    <>
      <header className="brand-band relative flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <BrandMark />
          <div className="leading-tight">
            <div className="text-white font-semibold tracking-tight text-sm">
              {PLATFORM_NAME}
            </div>
            <div
              className="text-[10px] uppercase tracking-[0.18em] font-semibold"
              style={{ color: "hsl(var(--penn-gold-soft))" }}
            >
              {tenantLabel} · Admin workstation
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
  const { storefrontName, resolved } = useStorefrontBranding();
  const tenantLabel = resolved ? storefrontName : NEUTRAL_TENANT_LABEL;
  return (
    <footer
      className="text-[11px] px-6 py-3 border-t text-center font-medium tracking-wide"
      style={{
        color: "hsl(var(--ink-3))",
        backgroundColor: "hsl(var(--surface-2))",
        borderColor: "hsl(var(--line-1))",
      }}
    >
      {PLATFORM_NAME} · {tenantLabel} · Internal tooling · Not for patient use
    </footer>
  );
}

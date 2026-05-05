// "Compatible with your AirSense 11" badge for the product detail
// page (Phase F.1, layered on Phase 1's saved device + Phase B.3's
// compatibility data).
//
// Renders only when:
//   * Customer is signed in AND has a device on file.
//   * The product has at least one compatibility row that matches
//     the device manufacturer (model match preferred but
//     manufacturer-wide rows count too).
//
// Silent no-op otherwise — the absence of the badge isn't an error
// signal, it's just "this is a universal product or a different-
// machine product".

import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";

import { AccountApiError, fetchShopClinicalInfo } from "@/lib/account-api";
import { fetchProductCompatibility } from "@/lib/product-compatibility-api";

interface Props {
  productId: string;
}

export function CompatibleWithYoursBadge({ productId }: Props) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLabel(null);
    void (async () => {
      try {
        const [profile, compat] = await Promise.all([
          fetchShopClinicalInfo().catch((err) => {
            if (err instanceof AccountApiError) return null;
            throw err;
          }),
          fetchProductCompatibility(productId),
        ]);
        if (cancelled) return;
        if (!profile?.cpapDevice) return;
        const { manufacturer, model } = profile.cpapDevice;
        const match = compat.compatibility.find((row) => {
          if (
            row.machineManufacturer.toLowerCase() !== manufacturer.toLowerCase()
          ) {
            return false;
          }
          // null model in the compat row = manufacturer-wide.
          return (
            row.machineModel === null ||
            row.machineModel.toLowerCase() === model.toLowerCase()
          );
        });
        if (!match) return;
        setLabel(`${manufacturer} ${model}`.trim());
      } catch {
        // Silently fail — missing badge is fine, broken page isn't.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [productId]);

  if (!label) return null;
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 border border-emerald-200 px-2.5 py-1 text-xs font-semibold text-emerald-800"
      data-testid="compatible-with-yours-badge"
    >
      <CheckCircle2 className="w-3.5 h-3.5" />
      Compatible with your {label}
    </div>
  );
}

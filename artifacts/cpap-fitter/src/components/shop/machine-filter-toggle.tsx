// Customer-facing parts-finder filter toggle (Phase F.1).
//
// Shows above the catalog grid only when the customer is signed
// in AND has a CPAP device on file. Flipping it on filters the
// product list to "compatible with my AirSense 11" + universal
// products. Designed to be unmissable but unobtrusive — gold
// border + machine name in the label.

import { Settings2, Loader2 } from "lucide-react";

import type { CpapDeviceInfo } from "@/lib/account-api";

interface Props {
  device: CpapDeviceInfo | null;
  enabled: boolean;
  loading: boolean;
  onChange: (next: boolean) => void;
}

export function MachineFilterToggle({
  device,
  enabled,
  loading,
  onChange,
}: Props) {
  if (!device) return null;
  const label = `${device.manufacturer} ${device.model}`.trim();
  return (
    <div
      className="inline-flex items-center gap-3 rounded-full border border-[hsl(var(--penn-gold)/0.6)] bg-[hsl(var(--penn-gold)/0.10)] px-3 py-1.5"
      data-testid="machine-filter-toggle"
    >
      <Settings2 className="w-3.5 h-3.5 text-[hsl(var(--penn-navy))]" />
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={() => onChange(!enabled)}
        className="inline-flex items-center gap-2 text-xs font-semibold text-[hsl(var(--penn-navy))] rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--penn-navy))] focus-visible:ring-offset-2"
      >
        <span
          className={`inline-flex h-4 w-7 items-center rounded-full transition-colors ${
            enabled ? "bg-[hsl(var(--penn-navy))]" : "bg-slate-300"
          }`}
          aria-hidden="true"
        >
          <span
            className={`inline-block h-3 w-3 rounded-full bg-white shadow transform transition-transform ${
              enabled ? "translate-x-3.5" : "translate-x-0.5"
            }`}
          />
        </span>
        Show only parts that fit my {label}
      </button>
      {loading && (
        <Loader2 className="w-3.5 h-3.5 animate-spin text-[hsl(var(--penn-navy))]/60" />
      )}
    </div>
  );
}

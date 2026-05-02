/**
 * Friendly labels for the reminder SKU strings stored on
 * reminder_subscriptions.items[].sku.
 *
 * These MUST stay in sync with the canonical list in
 * `artifacts/cpap-fitter/src/lib/reminder-defaults.ts` (the source
 * of truth — used by the storefront subscribe form). The dashboard
 * only needs the label lookup, so we copy that subset here rather
 * than depending on cpap-fitter (which is a sibling artifact and
 * must not import from another artifact's `src/`).
 */

const SKU_LABEL: Record<string, string> = {
  maskCushion: "Mask cushion / nasal pillows",
  maskFrameHeadgear: "Mask frame & headgear clips",
  headgear: "Headgear straps",
  tubing: "CPAP tubing",
  disposableFilter: "Disposable filters (white / paper)",
  reusableFilter: "Reusable filters (gray foam)",
  waterChamber: "Humidifier water chamber",
};

/**
 * Falls back to the raw SKU string for unknown values so the admin
 * UI doesn't blank out if the storefront introduces a new SKU
 * before the dashboard is redeployed.
 */
export function labelForSku(sku: string): string {
  return SKU_LABEL[sku] ?? sku;
}

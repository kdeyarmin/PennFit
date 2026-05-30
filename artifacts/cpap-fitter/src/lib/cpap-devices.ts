// Curated catalog of common CPAP / BiPAP / APAP machines, used by
// the /account "Your CPAP machine" dropdown.
//
// Why a curated list rather than free-text:
//   * Customers refer to the same machine by many different names
//     ("AirSense 11", "AS 11", "ResMed 11", "the new ResMed"). Free
//     text turned the saved profile into noise that the parts-finder
//     filter (`useMachineFilter`) could not reliably match against
//     the canonical `machine_manufacturer` / `machine_model` strings
//     in `shop_product_compatibility`.
//   * Picking from a list normalizes the saved value to the same
//     canonical string the seeded compatibility rows use, so
//     "Compatible with your machine" and the catalog filter Just Work.
//
// Each entry stores the canonical (manufacturer, model) pair plus a
// list of alternate names a customer might search for in the
// dropdown. Alternates are search-only — they never get persisted.
//
// "Other / not listed" is handled separately by the form: when the
// shopper picks it, free-text manufacturer + model inputs appear so
// older or less common machines can still be saved.

export interface CpapDeviceOption {
  /** Stable id used as the Select value. */
  id: string;
  manufacturer: string;
  model: string;
  /** Lowercased alternate names used by the typeahead search. */
  aliases: string[];
}

export const CPAP_DEVICE_CATALOG: CpapDeviceOption[] = [
  // ─── ResMed ──────────────────────────────────────────────────
  {
    id: "resmed-airsense-11-autoset",
    manufacturer: "ResMed",
    model: "AirSense 11 AutoSet",
    aliases: ["airsense 11", "as11", "as 11", "resmed 11"],
  },
  {
    id: "resmed-airsense-10-autoset",
    manufacturer: "ResMed",
    model: "AirSense 10 AutoSet",
    aliases: ["airsense 10", "as10", "as 10", "resmed 10"],
  },
  {
    id: "resmed-airsense-10-autoset-for-her",
    manufacturer: "ResMed",
    model: "AirSense 10 AutoSet for Her",
    aliases: ["airsense 10 for her", "as10 for her"],
  },
  {
    id: "resmed-airsense-10-cpap",
    manufacturer: "ResMed",
    model: "AirSense 10 CPAP",
    aliases: ["airsense 10 fixed", "as10 cpap"],
  },
  {
    id: "resmed-aircurve-11-vauto",
    manufacturer: "ResMed",
    model: "AirCurve 11 VAuto",
    aliases: ["aircurve 11", "ac11 vauto", "ac 11 vauto"],
  },
  {
    id: "resmed-aircurve-10-vauto",
    manufacturer: "ResMed",
    model: "AirCurve 10 VAuto",
    aliases: ["aircurve 10", "ac10 vauto", "ac 10 vauto", "bipap resmed"],
  },
  {
    id: "resmed-aircurve-10-asv",
    manufacturer: "ResMed",
    model: "AirCurve 10 ASV",
    aliases: ["aircurve asv", "asv resmed"],
  },
  {
    id: "resmed-airmini-autoset",
    manufacturer: "ResMed",
    model: "AirMini AutoSet",
    aliases: ["airmini", "travel cpap resmed", "mini cpap"],
  },

  // ─── Philips Respironics ─────────────────────────────────────
  {
    id: "philips-dreamstation-2-auto",
    manufacturer: "Philips Respironics",
    model: "DreamStation 2 Auto CPAP",
    aliases: ["dreamstation 2", "ds2", "philips 2"],
  },
  {
    id: "philips-dreamstation-auto",
    manufacturer: "Philips Respironics",
    model: "DreamStation Auto CPAP",
    aliases: ["dreamstation", "ds1", "philips dreamstation"],
  },
  {
    id: "philips-dreamstation-bipap-auto",
    manufacturer: "Philips Respironics",
    model: "DreamStation BiPAP Auto",
    aliases: ["dreamstation bipap", "philips bipap"],
  },
  {
    id: "philips-dreamstation-go",
    manufacturer: "Philips Respironics",
    model: "DreamStation Go",
    aliases: ["dreamstation go", "travel philips", "philips travel"],
  },

  // ─── Fisher & Paykel ────────────────────────────────────────
  {
    id: "fp-sleepstyle-auto",
    manufacturer: "Fisher & Paykel",
    model: "SleepStyle Auto CPAP",
    aliases: ["sleepstyle", "f&p sleepstyle", "fisher paykel"],
  },
  {
    id: "fp-icon-plus-auto",
    manufacturer: "Fisher & Paykel",
    model: "ICON+ Auto",
    aliases: ["icon", "icon+", "f&p icon"],
  },

  // ─── Apex / Other ────────────────────────────────────────────
  {
    id: "apex-iCH-auto",
    manufacturer: "Apex Medical",
    model: "iCH II Auto",
    aliases: ["ich auto", "apex ich"],
  },
  {
    id: "transcend-3-miniCPAP",
    manufacturer: "Transcend",
    model: "Transcend 3 miniCPAP",
    aliases: ["transcend 3", "transcend mini"],
  },
  {
    id: "luna-g3-auto",
    manufacturer: "React Health",
    model: "Luna G3 Auto",
    aliases: ["luna g3", "3b luna", "react health luna"],
  },
];

/**
 * Sentinel id for the "I don't see my machine" / "Other" fallback.
 * The DeviceForm switches to free-text inputs when this is selected
 * so the customer can still save an older or unlisted machine.
 */
export const CPAP_DEVICE_OTHER_ID = "__other__";

/**
 * Look up the catalog entry whose canonical (manufacturer, model)
 * matches the given pair, case-insensitively. Returns null when the
 * saved device was entered via the "Other" path or predates the
 * catalog — the caller should fall back to free-text editing.
 */
export function findCpapDeviceByManufacturerModel(
  manufacturer: string | null | undefined,
  model: string | null | undefined,
): CpapDeviceOption | null {
  if (!manufacturer || !model) return null;
  const m = manufacturer.trim().toLowerCase();
  const md = model.trim().toLowerCase();
  return (
    CPAP_DEVICE_CATALOG.find(
      (d) => d.manufacturer.toLowerCase() === m && d.model.toLowerCase() === md,
    ) ?? null
  );
}

export function getCpapDeviceById(id: string): CpapDeviceOption | null {
  return CPAP_DEVICE_CATALOG.find((d) => d.id === id) ?? null;
}

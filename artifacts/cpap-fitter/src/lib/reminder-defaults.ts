/**
 * Canonical SKU list and recommended replacement intervals for the
 * reminder signup form. The intervals here are the practice's
 * "manufacturer cadence" recommendations — they match the table on
 * /learn/replacement-schedule.
 *
 * The SKU strings MUST stay in sync with the API's reminder SKU enum
 * (`SubscribeReminderRequest.items[].sku`) — the hand-maintained
 * `@workspace/api-zod` storefront schema and the api-client types. If
 * you add a new SKU, update it in those places too. (The OpenAPI/orval
 * codegen pipeline was retired in Task #37; those types are hand-edited
 * now.)
 */
export type ReminderSku =
  | "maskCushion"
  | "maskFrameHeadgear"
  | "headgear"
  | "tubing"
  | "disposableFilter"
  | "reusableFilter"
  | "waterChamber";

export interface ReminderItemDef {
  sku: ReminderSku;
  label: string;
  description: string;
  defaultIntervalDays: number;
  /** Whether to pre-check this item on the signup form. */
  defaultEnabled: boolean;
}

export const REMINDER_ITEMS: ReminderItemDef[] = [
  {
    sku: "maskCushion",
    label: "Mask cushion / nasal pillows",
    description: "Direct skin contact — silicone breaks down from facial oils.",
    defaultIntervalDays: 30,
    defaultEnabled: true,
  },
  {
    sku: "maskFrameHeadgear",
    label: "Mask frame & headgear clips",
    description: "Plastic stress-fractures from daily strap tension.",
    defaultIntervalDays: 90,
    defaultEnabled: true,
  },
  {
    sku: "headgear",
    label: "Headgear straps",
    description: "Elastic stretches and the fit gets sloppy.",
    defaultIntervalDays: 180,
    defaultEnabled: false,
  },
  {
    sku: "tubing",
    label: "CPAP tubing",
    description: "Bacterial buildup and micro-tears cause pressure leaks.",
    defaultIntervalDays: 90,
    defaultEnabled: true,
  },
  {
    sku: "disposableFilter",
    label: "Disposable filters (white / paper)",
    description:
      "Trap dust, dander, and pollen. A clogged filter strains the motor.",
    defaultIntervalDays: 14,
    defaultEnabled: true,
  },
  {
    sku: "reusableFilter",
    label: "Reusable filters (gray foam)",
    description: "Even with washing, foam degrades and loses filtration.",
    defaultIntervalDays: 180,
    defaultEnabled: false,
  },
  {
    sku: "waterChamber",
    label: "Humidifier water chamber",
    description: "Mineral scaling clouds plastic and hosts bacteria.",
    defaultIntervalDays: 180,
    defaultEnabled: true,
  },
];

/**
 * Look up a friendly label for an SKU. Falls back to the raw SKU string
 * if it's an unknown value (defensive — keeps the admin UI from blanking
 * out if the server adds a new SKU before the client redeploys).
 */
export function labelForSku(sku: string): string {
  return REMINDER_ITEMS.find((d) => d.sku === sku)?.label ?? sku;
}

export function todayIso(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Common CPAP / BiPAP DME resupply HCPCS codes with short descriptions.
//
// There is no master HCPCS catalog on the frontend, but the resupply
// business turns over a small, well-known set of codes. This static list
// powers type-ahead on the HCPCS inputs: a code can be matched by its code
// (type "a7030") or by its description (type "tubing" → A7037). It is a
// convenience for data entry — arbitrary codes are still accepted, so the
// list does not need to be exhaustive.

export interface HcpcsCodeOption {
  code: string;
  description: string;
}

export const CPAP_HCPCS_CODES: readonly HcpcsCodeOption[] = [
  // Devices
  { code: "E0601", description: "CPAP device" },
  {
    code: "E0470",
    description: "Respiratory assist device (BiPAP), no backup rate",
  },
  {
    code: "E0471",
    description: "Respiratory assist device (BiPAP), with backup rate",
  },
  // Masks & interfaces
  { code: "A7027", description: "Combination oral/nasal mask" },
  {
    code: "A7028",
    description: "Oral cushion for combination mask (replacement)",
  },
  {
    code: "A7029",
    description: "Nasal pillows for combination mask (replacement, pair)",
  },
  { code: "A7030", description: "Full face mask" },
  { code: "A7031", description: "Full face mask cushion (replacement)" },
  { code: "A7032", description: "Nasal mask cushion (replacement)" },
  { code: "A7033", description: "Nasal pillows (replacement, pair)" },
  { code: "A7034", description: "Nasal interface (mask or cannula type)" },
  { code: "A7044", description: "Oral interface" },
  // Accessories
  { code: "A7035", description: "Headgear" },
  { code: "A7036", description: "Chinstrap" },
  { code: "A7037", description: "Tubing" },
  { code: "A7038", description: "Filter, disposable" },
  { code: "A7039", description: "Filter, non-disposable" },
  { code: "A7045", description: "Exhalation port" },
  { code: "A7046", description: "Water chamber for humidifier (replacement)" },
  { code: "A4604", description: "Tubing with integrated heating element" },
  // Humidifiers
  { code: "E0561", description: "Humidifier, non-heated" },
  { code: "E0562", description: "Humidifier, heated" },
] as const;
